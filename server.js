#!/usr/bin/env node
/**
 * Obsidian Reader - lightweight HTTP server (Node.js)
 * Serves:
 *   /              → dist/index.html (the SPA)
 *   /data/*        → dist/data/* (catalog.json)
 *   /vault/*       → Obsidian vault files (raw markdown, on-the-fly)
 *   /api/rescan    → re-scan vault and regenerate catalog.json
 *   /api/config    → GET/POST vault path config
 *   /api/auth      → POST password check
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const url = require('url');
const os = require('os');

const DIR = __dirname;
const DIST = path.join(DIR, 'dist');
const CONFIG_PATH = path.join(DIR, 'config.json');
const PYTHON = '/usr/bin/python3';
const TTS_CACHE = '/tmp/obsidian-reader-tts';
const TTS_VOICE = 'zh-CN-XiaoxiaoNeural';
const SECRET_PATH = path.join(DIR, '.session-secret');
const READ_STATE_PATH = path.join(DIR, 'read-articles.json');
const TTS_MAX_TEXT_BYTES = 100 * 1024; // edge-tts argv safety, ~100KB
const SSE_MAX_PER_IP = 5;
const AUTH_RATE_WINDOW_MS = 60 * 1000;
const AUTH_RATE_LIMIT = 10;

// ── Load config ──────────────────────────────────────
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {
    // Safe defaults for a *missing* config: bind to loopback (never 0.0.0.0)
    // and no password — so a lost/reset config can't silently expose the vault
    // to the network. A real deployment ships its own config.json with bind set.
    return { vault: '', port: 8765, bind: '127.0.0.1', password: '' };
  }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
}

// Atomic write for user-owned files (vault .md, 笔记.md). These are the only
// primary copy of the user's data — a crash mid-writeFileSync would truncate
// the file and iCloud would happily sync the truncated version everywhere.
// read-state and align caches already use tmp+rename; user data gets it too.
function atomicWriteSync(p, data) {
  const tmp = path.join(path.dirname(p), '.ocw-tmp-' + process.pid + '-' + crypto.randomBytes(3).toString('hex'));
  fs.writeFileSync(tmp, data, 'utf-8');
  try {
    fs.renameSync(tmp, p);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

let config = loadConfig();

// Alignment cache version — single source of truth shared with align.py via
// align-version.json. Bump it there; both sides pick it up. Re-read per
// request (mtime-cached, <1ms): align.py reads the file on every run, so a
// startup-time const here would go permanently stale after a bump without a
// server restart — every cache compare would then mismatch and EVERY article
// open would silently re-run the ~10s alignment and rewrite its cache file.
let _alignVerCache = { v: 14, mtime: -1 };
function alignVersion() {
  try {
    const p = path.join(DIR, 'align-version.json');
    const mt = fs.statSync(p).mtimeMs;
    if (mt !== _alignVerCache.mtime) {
      _alignVerCache = { v: Number(JSON.parse(fs.readFileSync(p, 'utf-8')).version) || 14, mtime: mt };
    }
  } catch { /* keep last known value */ }
  return _alignVerCache.v;
}

function sha1File(p) {
  const h = crypto.createHash('sha1');
  h.update(fs.readFileSync(p));
  return h.digest('hex');
}

// Path-containment check that respects directory boundaries. A bare
// `child.startsWith(base)` is wrong: "/x/vault-backup" startsWith "/x/vault"
// is true but it's a *sibling*, not inside. Require an exact match or a
// trailing separator so sibling dirs sharing a name prefix can't be escaped to.
function isInside(base, target) {
  const b = path.resolve(base);
  const t = path.resolve(target);
  return t === b || t.startsWith(b + path.sep);
}

// ── Read state (cross-device, per-id last-write-wins) ──
// Single-process server. Two maps:
//   _reads:      Map<id, ts>  when the article was marked read
//   _tombstones: Map<id, ts>  when it was unmarked
// An id is "read" iff it's in _reads and its ts >= any tombstone ts. The
// tombstones are what let a peer's *unmark* survive a stale peer that still
// has the id locally (the old union-merge could only ever re-add, so unmarks
// resurrected across devices).
let _reads = new Map();
let _tombstones = new Map();
const _TOMBSTONE_TTL_MS = 180 * 24 * 60 * 60 * 1000;
function _isRead(id) {
  const r = _reads.get(id);
  if (r === undefined) return false;
  const t = _tombstones.get(id);
  return t === undefined || r >= t;
}
function _readList() {
  const out = [];
  for (const id of _reads.keys()) if (_isRead(id)) out.push(id);
  return out.sort();
}
function _loadReadState() {
  _reads = new Map();
  _tombstones = new Map();
  try {
    const obj = JSON.parse(fs.readFileSync(READ_STATE_PATH, 'utf-8'));
    if (Array.isArray(obj)) {
      for (const id of obj) if (typeof id === 'string') _reads.set(id, 0);
    } else if (obj && typeof obj === 'object') {
      const arts = obj.articles;
      if (Array.isArray(arts)) { for (const id of arts) if (typeof id === 'string') _reads.set(id, 0); }
      else if (arts && typeof arts === 'object') { for (const [id, ts] of Object.entries(arts)) _reads.set(id, Number(ts) || 0); }
      if (obj.reads && typeof obj.reads === 'object') for (const [id, ts] of Object.entries(obj.reads)) _reads.set(id, Number(ts) || 0);
      if (obj.tombstones && typeof obj.tombstones === 'object') for (const [id, ts] of Object.entries(obj.tombstones)) _tombstones.set(id, Number(ts) || 0);
    }
  } catch {}
}
function _persistReadState() {
  const cutoff = Date.now() - _TOMBSTONE_TTL_MS;
  for (const [id, ts] of _tombstones) if (ts && ts < cutoff) _tombstones.delete(id);
  const reads = {}, tombs = {};
  for (const [id, ts] of _reads) reads[id] = ts;
  for (const [id, ts] of _tombstones) tombs[id] = ts;
  const tmp = READ_STATE_PATH + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify({ articles: _readList(), reads, tombstones: tombs }, null, 0) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, READ_STATE_PATH);
  } catch (e) {
    console.warn('[read-state] persist failed:', e.message);
  }
}
_loadReadState();

// ── Reading stats (time-on-article, per local day) ───
// Aggregated at write time: _stats.days[YYYY-MM-DD][articleId] = [readMs, listenMs].
// Clients send monotonic *deltas* (60s heartbeats + a final sendBeacon), so
// multi-device merging is plain addition — no LWW needed. Granularity is
// deliberately day×article: enough for every stats-page view, tiny on disk,
// and never needs pruning.
const STATS_PATH = path.join(DIR, 'stats.json');
// Per-entry delta cap. A legit flush is ≤60s of wall clock; 30 min absorbs a
// missed-beacon backlog while making a client clock jump harmless.
const STATS_MAX_DELTA_MS = 30 * 60 * 1000;
let _stats = { days: {} };
let _statsDirty = false;
let _statsFlushTimer = null;
function _loadStats() {
  try {
    const obj = JSON.parse(fs.readFileSync(STATS_PATH, 'utf-8'));
    if (obj && typeof obj === 'object' && obj.days && typeof obj.days === 'object') _stats = { days: obj.days };
  } catch {}
}
function _persistStats() {
  _statsDirty = false;
  const tmp = STATS_PATH + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(_stats, null, 0) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, STATS_PATH);
  } catch (e) {
    console.warn('[stats] persist failed:', e.message);
  }
}
// Coalesce bursts (two devices heartbeating together) into one write.
function _scheduleStatsFlush() {
  _statsDirty = true;
  if (_statsFlushTimer) return;
  _statsFlushTimer = setTimeout(() => {
    _statsFlushTimer = null;
    if (_statsDirty) _persistStats();
  }, 5000);
  if (_statsFlushTimer.unref) _statsFlushTimer.unref();
}
function _localDayStr(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function _addStatsDelta(articleId, readMs, listenMs) {
  const day = _localDayStr(Date.now());
  const bucket = _stats.days[day] || (_stats.days[day] = {});
  const cur = bucket[articleId] || (bucket[articleId] = [0, 0]);
  cur[0] += readMs;
  cur[1] += listenMs;
}
_loadStats();

// ── Stats summary helpers ────────────────────────────
// Catalog snapshot for stats rollups, re-parsed only when the file changes.
let _statsCatCache = { mtime: -1, arts: [] };
function _statsCatalogArts() {
  try {
    const mt = fs.statSync(CATALOG_PATH).mtimeMs;
    if (mt !== _statsCatCache.mtime) {
      const c = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf-8'));
      _statsCatCache = { mtime: mt, arts: Array.isArray(c.articles) ? c.articles : [] };
    }
  } catch {}
  return _statsCatCache.arts;
}

// Audio/subtitle coverage walks every article with an audio sibling
// (~1200 stat + head reads) — cached and refreshed at most every 10 min.
const _VTT_COV_TTL_MS = 10 * 60 * 1000;
let _vttCovCache = { at: 0, catalogMtime: -1, cov: null };
function _libraryCoverage() {
  const arts = _statsCatalogArts();
  const now = Date.now();
  if (_vttCovCache.cov && _vttCovCache.catalogMtime === _statsCatCache.mtime && now - _vttCovCache.at < _VTT_COV_TTL_MS) {
    return _vttCovCache.cov;
  }
  let withAudio = 0, withVtt = 0, qwenVtt = 0;
  const vault = config.vault || '';
  for (const a of arts) {
    const audio = a.meta && a.meta.audio;
    if (!audio || typeof audio !== 'string') continue;
    withAudio++;
    if (!vault) continue;
    const dot = audio.lastIndexOf('.');
    if (dot <= audio.lastIndexOf('/')) continue;
    const vtt = path.join(vault, audio.slice(0, dot) + '.vtt');
    try {
      if (!fs.existsSync(vtt)) continue;
      withVtt++;
      if (!_isLegacyVtt(vtt)) qwenVtt++;
    } catch {}
  }
  const cov = { totalArticles: arts.length, withAudio, withVtt, qwenVtt };
  _vttCovCache = { at: now, catalogMtime: _statsCatCache.mtime, cov };
  return cov;
}

// Batch re-transcription progress, read from an external state file (the
// batch job lives outside this repo). Optional: configure
// config.retranscribeStatePath; when unset the stats page hides the block.
function _retransState() {
  const p = config.retranscribeStatePath;
  if (!p || typeof p !== 'string') return null;
  try {
    const s = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return {
      total: Number(s.total) || 0,
      done: Number(s.done) || 0,
      failed: Number(s.failed) || 0,
      updatedAt: s.updated_at || null,
      finishedAt: s.finished_at || null,
    };
  } catch { return null; }
}

function _buildStatsSummary() {
  const now = Date.now();
  const todayStr = _localDayStr(now);
  const wk = new Date(now);
  wk.setHours(0, 0, 0, 0);
  wk.setDate(wk.getDate() - ((wk.getDay() + 6) % 7)); // Monday-start week
  const weekStartStr = _localDayStr(wk.getTime());
  const monthStartStr = todayStr.slice(0, 8) + '01';
  const yearAgoStr = _localDayStr(now - 366 * 86400000);

  // One pass over the day buckets: period sums, per-article rollup, heatmap.
  const perArt = new Map(); // id -> { ms, lastDay }
  const heatmap = {};       // day -> [totalMs, articlesFinished]
  const today = [0, 0], week = [0, 0], month = [0, 0], allTime = [0, 0];
  for (const [day, bucket] of Object.entries(_stats.days)) {
    let dayMs = 0;
    for (const [id, v] of Object.entries(bucket)) {
      const r = Number(v[0]) || 0, l = Number(v[1]) || 0;
      dayMs += r + l;
      const pa = perArt.get(id) || { ms: 0, lastDay: '' };
      pa.ms += r + l;
      if (day > pa.lastDay) pa.lastDay = day;
      perArt.set(id, pa);
      allTime[0] += r; allTime[1] += l;
      if (day === todayStr) { today[0] += r; today[1] += l; }
      if (day >= weekStartStr) { week[0] += r; week[1] += l; }
      if (day >= monthStartStr) { month[0] += r; month[1] += l; }
    }
    if (day >= yearAgoStr && dayMs > 0) heatmap[day] = [dayMs, 0];
  }

  // Finished-article counts from read-state timestamps. Legacy reads carry
  // ts=0 — they count toward the all-time total but land on no calendar day,
  // so pre-instrumentation history shows up honestly as "count, no time".
  let weekFin = 0, monthFin = 0, totalFin = 0;
  for (const [id, ts] of _reads) {
    if (!_isRead(id)) continue;
    totalFin++;
    if (!ts) continue;
    const day = _localDayStr(ts);
    if (day > todayStr) continue; // future clock skew — keep off the heatmap
    if (day >= yearAgoStr) (heatmap[day] = heatmap[day] || [0, 0])[1]++;
    if (day >= weekStartStr) weekFin++;
    if (day >= monthStartStr) monthFin++;
  }

  // Course rollup: meta.course groups module subfolders of one course
  // together; everything else groups by its subcategory path.
  const arts = _statsCatalogArts();
  const courseMap = new Map();
  const artById = new Map();
  for (const a of arts) {
    artById.set(a.id, a);
    // Group key: meta.course when present; otherwise the subcategory's last
    // path segment. The trailing segment matches meta.course naming, so a
    // course whose articles only partially carry meta.course (mixed scrape
    // eras) still rolls up into ONE group instead of two near-duplicates.
    const key = (a.meta && a.meta.course) ||
      (a.subcategory ? a.subcategory.split('/').pop() : '') || a.category || '未分类';
    const c = courseMap.get(key) || { name: key, total: 0, read: 0, ms: 0, lastDay: '', sub: null };
    // Sidebar anchor for click-through: deepest path shared by the group's
    // articles (a meta.course can span several module subfolders).
    const subPath = (a.category || '') + (a.subcategory ? '/' + a.subcategory : '');
    if (c.sub === null) c.sub = subPath;
    else if (c.sub !== subPath) {
      const x = c.sub.split('/'), y = subPath.split('/');
      let i = 0;
      while (i < x.length && i < y.length && x[i] === y[i]) i++;
      c.sub = x.slice(0, i).join('/');
    }
    c.total++;
    if (_isRead(a.id)) {
      c.read++;
      const ts = _reads.get(a.id);
      if (ts) { const d = _localDayStr(ts); if (d > c.lastDay && d <= todayStr) c.lastDay = d; }
    }
    const pa = perArt.get(a.id);
    if (pa) { c.ms += pa.ms; if (pa.lastDay > c.lastDay) c.lastDay = pa.lastDay; }
    courseMap.set(key, c);
  }
  const courses = [...courseMap.values()].sort((x, y) =>
    x.lastDay === y.lastDay ? y.ms - x.ms : (x.lastDay < y.lastDay ? 1 : -1));

  // Recently-active articles (have logged time + still exist in the catalog).
  const recent = [...perArt.entries()]
    .filter(([id]) => artById.has(id))
    .sort((a, b) => a[1].lastDay === b[1].lastDay ? b[1].ms - a[1].ms : (a[1].lastDay < b[1].lastDay ? 1 : -1))
    .slice(0, 10)
    .map(([id, pa]) => {
      const a = artById.get(id);
      return {
        id,
        title: a.title,
        course: (a.meta && a.meta.course) || a.subcategory || '',
        ms: pa.ms,
        lastDay: pa.lastDay,
        read: _isRead(id),
      };
    });

  return {
    ok: true,
    today: { readMs: today[0], listenMs: today[1] },
    week: { readMs: week[0], listenMs: week[1], finished: weekFin },
    month: { readMs: month[0], listenMs: month[1], finished: monthFin },
    allTime: { readMs: allTime[0], listenMs: allTime[1], finished: totalFin },
    heatmap,
    courses,
    recent,
    library: _libraryCoverage(),
    retranscribe: _retransState(),
  };
}

// ── Auth ─────────────────────────────────────────────
// HMAC-based stateless tokens: token = base64url(uid).base64url(hmac(uid))
// Persisted SESSION_SECRET so tokens survive process restarts.
function _loadOrCreateSecret() {
  try {
    const v = fs.readFileSync(SECRET_PATH, 'utf-8').trim();
    if (v && v.length >= 32) return v;
  } catch {}
  const v = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(SECRET_PATH, v + '\n', { mode: 0o600 });
    fs.chmodSync(SECRET_PATH, 0o600);
  } catch (e) { console.warn('[auth] could not persist session secret:', e.message); }
  return v;
}
const _secretRef = { value: _loadOrCreateSecret() };
function rotateSessionSecret() {
  const v = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(SECRET_PATH, v + '\n', { mode: 0o600 });
    fs.chmodSync(SECRET_PATH, 0o600);
  } catch (e) { console.warn('[auth] rotate persist failed:', e.message); }
  _secretRef.value = v;
}
const _transcribeInProgress = new Set();
const _transcribeProcs = new Set();      // live transcription child procs (group-killed on shutdown)
const TRANSCRIBE_MAX_CONCURRENT = 1;     // one 2GB MLX model at a time
const TRANSCRIBE_QUEUE_MAX = 16;
const _transcribeQueue = [];             // [{resolved, opts}] waiting for a slot

function _drainTranscribeQueue() {
  while (_transcribeQueue.length && _transcribeInProgress.size < TRANSCRIBE_MAX_CONCURRENT) {
    const next = _transcribeQueue.shift();
    _startTranscription(next.resolved, next.opts);
  }
}
const _retranscribeFailed = new Set();   // audio paths whose auto re-transcribe failed this run
const _alignInFlight = new Map();        // cachePath → Promise (dedup concurrent /api/align)
const _ttsInProgress = new Map(); // baseName → Promise of result

// ── Alignment daemon ────────────────────────────────
// align.py --daemon keeps the embedding model warm, so per-article alignment
// costs <1s instead of ~10s of torch import + model load per spawn (measured
// modelLoadTime across the library: 8.0-16.1s, alignTime 0.3-3.9s). Managed
// lazily: spawned on first use, killed after 10 min idle; any failure falls
// back to the classic one-shot spawn path below.
const ALIGN_DAEMON_IDLE_MS = 10 * 60 * 1000;
let _alignDaemon = null;

function _killAlignDaemon(reason) {
  const d = _alignDaemon;
  if (!d) return;
  _alignDaemon = null;
  clearTimeout(d.idleTimer);
  clearTimeout(d.readyTimer);
  // Reject d.ready too (no-op if already resolved): a daemon that crashes
  // during startup used to leave awaiting requests hanging the full 300s
  // ready-timeout before they could fall back to one-shot spawn.
  try { d._readyReject(new Error('align daemon terminated: ' + reason)); } catch {}
  for (const [, p] of d.pending) { clearTimeout(p.timer); p.reject(new Error('align daemon terminated: ' + reason)); }
  d.pending.clear();
  try { d.proc.kill(); } catch {}
}

function _ensureAlignDaemon() {
  if (_alignDaemon) return _alignDaemon;
  const proc = spawn(PYTHON, [path.join(DIR, 'align.py'), '--daemon'], {
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
  });
  const d = { proc, pending: new Map(), nextId: 1, buf: '', stderr: '', idleTimer: null, readyTimer: null };
  d.ready = new Promise((resolve, reject) => { d._readyResolve = resolve; d._readyReject = reject; });
  d.ready.catch(() => {}); // avoid unhandled-rejection if no request is waiting
  d.readyTimer = setTimeout(() => {
    d._readyReject(new Error('align daemon start timeout'));
    if (_alignDaemon === d) _killAlignDaemon('start timeout');
  }, 300000);
  // Async EPIPE: the daemon can die between our liveness check and the write
  // landing; the resulting 'error' event on stdin has no other listener and
  // would crash the process. Cleanup is handled by the 'exit' handler.
  proc.stdin.on('error', () => {});
  proc.stdout.on('data', chunk => {
    d.buf += chunk.toString();
    let nl;
    while ((nl = d.buf.indexOf('\n')) >= 0) {
      const line = d.buf.slice(0, nl).trim();
      d.buf = d.buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.ready) {
        clearTimeout(d.readyTimer);
        console.log(`[align] daemon ready (model load ${msg.modelLoadTime}s)`);
        d._readyResolve();
        continue;
      }
      const p = d.pending.get(msg.id);
      if (p) { d.pending.delete(msg.id); clearTimeout(p.timer); p.resolve(msg); }
    }
  });
  proc.stderr.on('data', c => { d.stderr = (d.stderr + c.toString()).slice(-2000); });
  proc.on('exit', (code) => {
    if (_alignDaemon === d) {
      if (d.pending.size) console.warn(`[align] daemon exited code=${code}: ${d.stderr.slice(-300)}`);
      _killAlignDaemon('exit ' + code);
    }
  });
  proc.on('error', (e) => {
    d._readyReject(e);
    if (_alignDaemon === d) _killAlignDaemon(e.message);
  });
  _alignDaemon = d;
  _touchDaemonIdle();
  return d;
}

function _touchDaemonIdle() {
  const d = _alignDaemon;
  if (!d) return;
  clearTimeout(d.idleTimer);
  d.idleTimer = setTimeout(() => {
    if (!_alignDaemon) return;
    if (_alignDaemon.pending.size === 0) _killAlignDaemon('idle');
    else _touchDaemonIdle();
  }, ALIGN_DAEMON_IDLE_MS);
}

async function _alignViaDaemon(article, vtt, out, segments) {
  const d = _ensureAlignDaemon();
  await d.ready;
  const msg = await new Promise((resolve, reject) => {
    const id = d.nextId++;
    // A request timeout means the daemon is wedged (its loop is strictly
    // serial), not just slow — kill it so the NEXT request respawns fresh
    // instead of every article paying the full 120s before falling back.
    const timer = setTimeout(() => {
      d.pending.delete(id);
      reject(new Error('align daemon request timeout'));
      if (_alignDaemon === d) _killAlignDaemon('request timeout');
    }, 120000);
    d.pending.set(id, { resolve, reject, timer });
    try {
      d.proc.stdin.write(JSON.stringify({ id, article, vtt, out, segments: segments || null }) + '\n');
    } catch (e) { d.pending.delete(id); clearTimeout(timer); reject(e); }
    _touchDaemonIdle();
  });
  _touchDaemonIdle();
  if (!msg.ok) throw new Error(msg.error || 'align failed');
  return msg.stats;
}

function _alignOneShot(article, vtt, out, segments) {
  return new Promise((resolve, reject) => {
    const alignArgs = [path.join(DIR, 'align.py'), article, vtt, out];
    let segTmp = null;
    if (segments) {
      try {
        segTmp = path.join(require('os').tmpdir(), `align-segs-${process.pid}-${Date.now()}.json`);
        fs.writeFileSync(segTmp, JSON.stringify(segments));
        alignArgs.splice(1, 0, '--segments', segTmp);
      } catch (e) { segTmp = null; }
    }
    const cleanupSeg = () => { if (segTmp) { try { fs.unlinkSync(segTmp); } catch {} segTmp = null; } };
    // 300s (not 60s): a fresh install downloads the embedding model on first
    // run, which blows well past 60s and used to guarantee a timeout loop.
    const proc = spawn(PYTHON, alignArgs, {
      timeout: 300000,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    });
    let stderr = '';
    proc.stderr.on('data', d => stderr += d.toString());
    proc.on('close', (code) => {
      cleanupSeg();
      if (code === 0 && fs.existsSync(out)) resolve(null);
      else reject(new Error('Alignment failed: ' + stderr.slice(-200)));
    });
    proc.on('error', (err) => { cleanupSeg(); reject(new Error('Spawn failed: ' + err.message)); });
  });
}

async function _generateAlignment(article, vtt, out, segments) {
  const t0 = Date.now();
  try {
    const stats = await _alignViaDaemon(article, vtt, out, segments);
    console.log(`[align] generated (daemon ${Date.now() - t0}ms, segsHit=${stats.segsHit}/${stats.segments}): ${path.basename(out)}`);
    return;
  } catch (e) {
    console.warn('[align] daemon path failed, falling back to one-shot spawn:', e.message);
  }
  await _alignOneShot(article, vtt, out, segments);
  console.log(`[align] generated (spawn ${Date.now() - t0}ms): ${path.basename(out)}`);
}

// Effective hit ratio of a cached alignment. Bonus credit for segments that
// don't appear in the audio (footnotes, 划重点 summary lists) — they correctly
// stay unmapped. Trailing non-narrated segments are null (align.py leaves them
// unfilled so the follow-along highlight doesn't jump to the appendix); legacy
// caches collapsed them to a point at audioEnd. Both count as expected-unmapped
// tail so footnote-heavy articles aren't judged low-quality forever.
function _alignQuality(cached) {
  const st = cached.stats || {};
  const tr = cached.segTimeRanges || [];
  let tailUnmapped = 0;
  if (tr.length) {
    let audioEnd = null;
    for (let i = tr.length - 1; i >= 0; i--) { if (tr[i]) { audioEnd = tr[i].end; break; } }
    for (let i = tr.length - 1; i >= 0; i--) {
      const r = tr[i];
      if (!r) { tailUnmapped++; continue; }
      if (audioEnd !== null && Math.abs(r.start - audioEnd) < 0.01 && Math.abs(r.end - audioEnd) < 0.01) { tailUnmapped++; continue; }
      break;
    }
  }
  const effSegments = Math.max(1, (st.segments || 0) - tailUnmapped);
  return { hitRatio: (st.segsHit || 0) / effSegments, effSegments };
}

// VTTs written by qwen_vtt.py carry a "NOTE transcriber: qwen3-asr" line;
// anything without it predates the engine switch (whisper era, 2026-06-20)
// and is known to contain homophone errors and repetition loops.
function _isLegacyVtt(vttPath) {
  try {
    const fd = fs.openSync(vttPath, 'r');
    const buf = Buffer.alloc(300);
    const n = fs.readSync(fd, buf, 0, 300, 0);
    fs.closeSync(fd);
    return !buf.toString('utf-8', 0, n).includes('NOTE transcriber: qwen');
  } catch { return false; }
}

function _findAudioForVtt(vttPath) {
  for (const ext of ['.mp3', '.m4a', '.wav', '.ogg']) {
    const p = vttPath.replace(/\.vtt$/i, ext);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// Start one transcription (shared by /api/transcribe and the legacy-VTT
// auto-upgrade queue). Returns 'cached' | 'in_progress' | 'started'.
//
// Engine: Qwen3-ASR-1.7B (MLX, 8bit) via qwen_vtt.py. 2026-06-20 — replaced
// mlx_whisper-large-v3-turbo, which hallucinated fabricated ad text
// ("请不吝点赞订阅...") and repetition loops on long Chinese lectures. Qwen is
// hallucination-free, ~4x faster than fp16, and qwen_vtt.py does ASR +
// per-chunk punctuation merge + natural (clause-level) cue grouping. It
// transcribes in its own temp dir, so the dot-free tmp path we hand it is
// honored verbatim (no mlx output-name multi-dot truncation); we then rename
// it to the final .vtt.
function _startTranscription(resolved, { force = false, auto = false } = {}) {
  const vttPath = resolved.replace(/\.[^.]+$/, '.vtt');
  if (fs.existsSync(vttPath) && !force) return 'cached';
  if (_transcribeInProgress.has(resolved)) return 'in_progress';
  // Global concurrency cap: each mlx-qwen3-asr loads a ~2GB model and can run
  // up to 20 min. Opening several untranscribed articles used to stack N MLX
  // processes trampling GPU/memory; excess jobs now wait in a small FIFO.
  if (_transcribeInProgress.size >= TRANSCRIBE_MAX_CONCURRENT) {
    if (_transcribeQueue.some(q => q.resolved === resolved)) return 'queued';
    if (_transcribeQueue.length >= TRANSCRIBE_QUEUE_MAX) return 'busy';
    _transcribeQueue.push({ resolved, opts: { force, auto } });
    return 'queued';
  }
  _transcribeInProgress.add(resolved);
  const outputDir = path.dirname(resolved);
  const qwenAsrBin = config.qwenAsrBin || process.env.QWEN_ASR_BIN || 'mlx-qwen3-asr';
  const qwenScript = path.join(DIR, 'qwen_vtt.py');
  const tmpStem = 'ocw_vtt_' + crypto.randomBytes(4).toString('hex');
  // Keep the tmp OUT of the vault: if node dies mid-transcription, an orphaned
  // job that runs to completion writes here (OS-purged tmp) instead of leaving
  // ocw_vtt_* junk that iCloud would sync to every device.
  const tmpVtt = path.join(os.tmpdir(), tmpStem + '.vtt');
  // detached → own process group, so the timeout/shutdown kill below reaches
  // the mlx-qwen3-asr GRANDCHILD too. A plain child SIGTERM (the old
  // spawn-option timeout) only killed the qwen_vtt.py middle layer and left
  // the model process orphaned, burning GPU with nobody to collect its output.
  const proc = spawn(PYTHON, [qwenScript, resolved, tmpVtt], {
    detached: true,
    env: { ...process.env, QWEN_ASR_BIN: qwenAsrBin }
  });
  proc._ocwTmpVtt = tmpVtt; // for cleanup in _reapChildren
  _transcribeProcs.add(proc);
  const killTimer = setTimeout(() => {
    console.error('[transcribe] timeout (20min), killing process group:', path.basename(resolved));
    try { process.kill(-proc.pid, 'SIGTERM'); } catch {}
    setTimeout(() => { try { process.kill(-proc.pid, 'SIGKILL'); } catch {} }, 10000);
  }, 1200000);
  let stderr = '';
  proc.stderr.on('data', d => stderr += d.toString());
  proc.on('close', (code) => {
    clearTimeout(killTimer);
    _transcribeProcs.delete(proc);
    _transcribeInProgress.delete(resolved);
    if (code === 0) {
      try {
        if (fs.existsSync(tmpVtt)) {
          if (fs.existsSync(vttPath)) {
            // Preserve the old VTT before overwriting: whisper-era VTTs can't
            // be regenerated (those models are gone from this machine).
            try {
              const bakDir = path.join(DIR, 'archive', 'vtt-backups', path.basename(outputDir));
              fs.mkdirSync(bakDir, { recursive: true });
              // COPYFILE_EXCL: never clobber an existing backup — the first
              // one is the irreplaceable whisper original; a second force
              // re-transcription would otherwise overwrite it with qwen output.
              fs.copyFileSync(vttPath, path.join(bakDir, path.basename(vttPath)), fs.constants.COPYFILE_EXCL);
            } catch (e) {
              if (e.code !== 'EEXIST') console.warn('[transcribe] VTT backup failed:', e.message);
            }
            fs.unlinkSync(vttPath);
          }
          try {
            fs.renameSync(tmpVtt, vttPath);
          } catch (e) {
            if (e.code === 'EXDEV') {
              // Vault on a different filesystem than tmpdir: stage next to the
              // target then rename, so the final replace stays atomic (a bare
              // copyFileSync to vttPath could leave a truncated VTT on crash —
              // and the old VTT is already gone at this point).
              const stage = vttPath + '.ocw-stage-' + process.pid;
              try {
                fs.copyFileSync(tmpVtt, stage);
                fs.renameSync(stage, vttPath);
              } catch (e2) {
                try { fs.unlinkSync(stage); } catch {}
                throw e2;
              }
              fs.unlinkSync(tmpVtt);
            } else throw e;
          }
          console.log(`[transcribe] OK${force ? ' (re-transcribed)' : ''}:`, path.basename(resolved));
        } else {
          console.error('[transcribe] OK exit but tmp vtt missing:', tmpVtt);
        }
      } catch (e) {
        console.error('[transcribe] rename failed:', e.message);
      }
    } else {
      console.error('[transcribe] failed:', path.basename(resolved), stderr.slice(-300));
      if (auto) _retranscribeFailed.add(resolved);
      try { if (fs.existsSync(tmpVtt)) fs.unlinkSync(tmpVtt); } catch {}
    }
    _drainTranscribeQueue();
  });
  proc.on('error', (err) => {
    clearTimeout(killTimer);
    _transcribeProcs.delete(proc);
    _transcribeInProgress.delete(resolved);
    if (auto) _retranscribeFailed.add(resolved);
    console.error('[transcribe] spawn error:', err.message);
    _drainTranscribeQueue();
  });
  return 'started';
}

// Legacy-VTT lazy upgrade: when follow-along is activated on an article whose
// VTT predates the Qwen engine, quietly re-transcribe it in the background
// (one at a time, only for articles the user demonstrably uses). The next
// activation then picks up the better VTT + a fresh alignment via the normal
// mtime staleness path.
function _autoRetranscribeLegacy(vttPath) {
  const audio = _findAudioForVtt(vttPath);
  if (!audio || _retranscribeFailed.has(audio)) return false;
  if (_transcribeInProgress.size > 0 || _transcribeQueue.length > 0) return false; // at most one; retry on a later activation
  console.log('[transcribe] legacy VTT queued for re-transcription:', path.basename(vttPath));
  return _startTranscription(audio, { force: true, auto: true }) === 'started';
}

// Kill the align daemon and any live transcription process groups on exit —
// launchd restarts (kickstart -k) would otherwise orphan the mlx grandchild.
function _reapChildren() {
  _killAlignDaemon('server shutdown');
  for (const p of _transcribeProcs) {
    try { process.kill(-p.pid, 'SIGTERM'); } catch {}
    if (p._ocwTmpVtt) { try { fs.unlinkSync(p._ocwTmpVtt); } catch {} }
  }
}
process.on('SIGTERM', () => { _reapChildren(); if (_statsDirty) _persistStats(); process.exit(0); });
process.on('SIGINT', () => { _reapChildren(); if (_statsDirty) _persistStats(); process.exit(0); });
// Last-resort guards. Without these a single async fs error (e.g. an evicted
// iCloud placeholder emitting EIO on a read stream) took the whole server
// down. Rejections are logged and survived; a truly uncaught sync exception
// still exits (state may be corrupt) but reaps children and leaves a trace
// for launchd to restart on.
process.on('unhandledRejection', (e) => {
  console.error('[fatal] unhandled rejection:', (e && e.stack) || e);
});
process.on('uncaughtException', (e) => {
  console.error('[fatal] uncaught exception:', (e && e.stack) || e);
  _reapChildren();
  process.exit(1);
});
// Rate limiting state
const _authFails = new Map();     // ip → [timestamp]
const _sseConnsByIp = new Map();  // ip → count

function _hmac(uid) {
  return crypto.createHmac('sha256', _secretRef.value).update(uid).digest('base64')
    .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function makeToken() {
  const uid = crypto.randomBytes(12).toString('hex');
  return uid + '.' + _hmac(uid);
}
function verifyToken(t) {
  if (!t || typeof t !== 'string') return false;
  const [uid, mac] = t.split('.');
  if (!uid || !mac || !/^[a-f0-9]+$/i.test(uid)) return false;
  const expected = _hmac(uid);
  if (expected.length !== mac.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(mac)); }
  catch { return false; }
}
// True iff the TCP connection itself comes from this machine (loopback),
// independent of any X-Forwarded-* header. Use this for "must be physically
// local" gates so a forged X-Forwarded-For can never make a remote request
// look local.
function _isDirectLoopback(req) {
  const ip = (req.socket && req.socket.remoteAddress) || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}
// Optional explicit allow-list of reverse-proxy source addresses. Entries are
// bare IPs ("192.168.1.10") or IPv4 CIDRs ("192.168.1.0/24"). When set, ONLY
// loopback + these peers are trusted to set X-Forwarded-* / X-Real-IP, so a
// random LAN client connecting directly can no longer forge the real-client IP
// (rate-limit/SSE keys) or the https flag (Secure cookie). When empty/unset we
// fall back to the broad RFC1918/ULA heuristic for backward compatibility.
const _trustedProxies = Array.isArray(config.trustedProxies)
  ? config.trustedProxies.filter(s => typeof s === 'string' && s.trim()).map(s => s.trim())
  : [];

function _ip4ToInt(s) {
  const p = s.split('.');
  if (p.length !== 4) return null;
  let n = 0;
  for (const o of p) {
    const v = Number(o);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = (n * 256) + v;
  }
  return n >>> 0;
}
function _matchProxyEntry(addr, entry) {
  const e = entry.replace(/^::ffff:/, '');
  if (e.includes('/')) {
    const [net, bitsStr] = e.split('/');
    const bits = Number(bitsStr);
    const ai = _ip4ToInt(addr), ni = _ip4ToInt(net);
    if (ai === null || ni === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
    if (bits === 0) return true;
    const mask = (0xffffffff << (32 - bits)) >>> 0;
    return (ai & mask) === (ni & mask);
  }
  return addr === e;
}
// True iff the direct peer is our reverse proxy (or local), i.e. the only peers
// whose forwarding headers we trust to recover the real client.
function _isTrustedPeer(ip) {
  if (!ip) return false;
  const a = ip.replace(/^::ffff:/, '');
  if (a === '127.0.0.1' || a === '::1') return true; // loopback is always us
  if (_trustedProxies.length) {
    return _trustedProxies.some(e => _matchProxyEntry(a, e));
  }
  // No explicit allow-list → trust any private/internal direct peer (legacy).
  return a.startsWith('10.') || a.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(a) ||
    /^f[cd]/i.test(a); // fc00::/7
}
function _reqIsHttps(req) {
  if (req.socket && req.socket.encrypted) return true;
  const direct = (req.socket && req.socket.remoteAddress) || '';
  if (!_isTrustedPeer(direct)) return false;
  return String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}
function _clientIp(req) {
  const direct = (req.socket && req.socket.remoteAddress) || 'unknown';
  if (_isTrustedPeer(direct)) {
    // X-Real-IP is set by the proxy to the peer it saw (overwrites any
    // client-supplied value), so it is not spoofable through the XFF chain.
    const real = req.headers['x-real-ip'];
    if (real) return String(real).trim();
    // Else take the LAST X-Forwarded-For hop — the one our trusted proxy
    // appended. Earlier entries are client-supplied and forgeable.
    const xff = req.headers['x-forwarded-for'];
    if (xff) {
      const parts = String(xff).split(',').map(s => s.trim()).filter(Boolean);
      if (parts.length) return parts[parts.length - 1];
    }
  }
  return direct;
}
function _rateLimitAuth(ip) {
  const now = Date.now();
  // Lazy sweep: /api/auth is internet-reachable pre-auth, and scanner bots hit
  // it from one-shot IPs whose entries were otherwise never reclaimed — the
  // only unbounded, externally-drivable structure in the process.
  if (_authFails.size > 1000) {
    for (const [k, v] of _authFails) {
      if (!v.length || now - v[v.length - 1] > AUTH_RATE_WINDOW_MS) _authFails.delete(k);
    }
  }
  const arr = (_authFails.get(ip) || []).filter(t => now - t < AUTH_RATE_WINDOW_MS);
  arr.push(now);
  _authFails.set(ip, arr);
  return arr.length > AUTH_RATE_LIMIT;
}

// ── Vault basename index (Obsidian-style short-link resolution) ──
// Maps lowercase basename → vault-relative path. Built lazily, invalidated by watcher.
let _basenameIndex = null;
let _basenameIndexBuilt = 0;
const _BASENAME_MIN_REBUILD_MS = 3000;
const _BASENAME_MAX_AGE_MS = 60000;
// Memo of successful bare-name resolutions. The full index above expires every
// 60s and is wholesale-invalidated by ANY watcher event, so during audio
// playback (bare-wikilink Range requests) the 40ms+ synchronous full-vault
// walk kept re-running on the hottest path. Memo entries are verified with a
// cheap existsSync on hit and precisely invalidated by watcher events.
const _basenameHits = new Map(); // normalized lowercase name → {p, t}
const _BASENAME_HITS_MAX = 5000;
// TTL keeps the old index's "at most 60s stale" contract in spirit: precise
// watcher invalidation is the fast path, but fs.watch can fail to start and
// iCloud drops fsevents — without an expiry a memo entry whose file still
// exists (but should no longer be the resolution target) could live forever.
const _BASENAME_HITS_TTL_MS = 10 * 60 * 1000;
// macOS FSEvents reports NFD names while URLs usually carry NFC — normalize
// both sides so precise invalidation actually matches.
function _basenameKey(name) { return String(name).normalize('NFC').toLowerCase(); }

function buildBasenameIndex() {
  const idx = new Map();
  if (!config.vault) { _basenameIndex = idx; _basenameIndexBuilt = Date.now(); return; }
  const root = config.vault;
  const walk = (dir) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of ents) {
      if (ent.name.startsWith('.')) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile()) {
        const key = ent.name.toLowerCase();
        if (!idx.has(key)) idx.set(key, path.relative(root, full));
      }
    }
  };
  walk(root);
  _basenameIndex = idx;
  _basenameIndexBuilt = Date.now();
}

function invalidateBasenameIndex() { _basenameIndex = null; }

// Resolve vault-relative path with Obsidian-style basename fallback.
// Returns absolute path (within vault) if found, else null.
function resolveVaultPath(rel) {
  if (!rel || !config.vault) return null;
  const direct = path.resolve(config.vault, rel);
  if (!isInside(config.vault, direct)) return null;
  if (fs.existsSync(direct)) return direct;
  // Fallback: only for bare filenames (no '/'), look up by basename
  if (rel.includes('/')) return null;
  const key = _basenameKey(rel);
  const memo = _basenameHits.get(key);
  if (memo) {
    if (Date.now() - memo.t < _BASENAME_HITS_TTL_MS && fs.existsSync(memo.p)) return memo.p;
    _basenameHits.delete(key); // expired or moved/deleted — fall through to index
  }
  const tryLookup = () => {
    const hit = _basenameIndex && _basenameIndex.get(key);
    return hit ? path.resolve(config.vault, hit) : null;
  };
  if (!_basenameIndex || Date.now() - _basenameIndexBuilt > _BASENAME_MAX_AGE_MS) {
    buildBasenameIndex();
  }
  let found = tryLookup();
  if (!found && Date.now() - _basenameIndexBuilt > _BASENAME_MIN_REBUILD_MS) {
    // Second chance: rebuild if cache is older than min-rebuild and retry once
    // (handles the case where a VTT/file was just created)
    buildBasenameIndex();
    found = tryLookup();
  }
  if (found) {
    if (_basenameHits.size >= _BASENAME_HITS_MAX) _basenameHits.clear();
    _basenameHits.set(key, { p: found, t: Date.now() });
  }
  return found;
}

function isAuthed(req) {
  // No password set: open ONLY to the local machine. Behind a reverse proxy or
  // on the LAN this denies access until a password is configured locally, so a
  // fresh/empty config never serves the vault to the network.
  if (!config.password) return _isDirectLoopback(req);
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/or_token=([A-Za-z0-9._\-]+)/);
  return !!(m && verifyToken(m[1]));
}

// ── MIME ─────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md':   'text/markdown; charset=utf-8',
  '.txt':  'text/plain; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.svg':  'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.mp3':  'audio/mpeg',
  '.wav':  'audio/wav',
  '.ogg':  'audio/ogg',
  '.m4a':  'audio/mp4',
  '.vtt':  'text/vtt; charset=utf-8',
  '.mp4':  'video/mp4',
  '.webm': 'video/webm',
};

function getMime(filepath) {
  return MIME[path.extname(filepath).toLowerCase()] || 'application/octet-stream';
}

// Pipe a file read stream into a response with an error handler attached.
// pipe() does NOT forward source-stream errors; an unhandled 'error' on the
// ReadStream (evicted iCloud placeholder → EIO, file deleted mid-playback)
// used to crash the whole process.
function streamTo(res, filepath, opts) {
  const stream = fs.createReadStream(filepath, opts);
  stream.on('error', (e) => {
    console.error(`[stream] read error: ${filepath}`, e.message);
    try {
      if (!res.headersSent) { res.writeHead(500); res.end('Read error'); }
      else res.destroy();
    } catch {}
  });
  stream.pipe(res);
}

function serveFile(res, filepath, cacheControl, req, etag) {
  fs.readFile(filepath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') { res.writeHead(404); res.end('Not found'); }
      else { console.error(`Read error: ${filepath}`, err.message); res.writeHead(500); res.end('Read error'); }
      return;
    }
    const headers = {
      'Content-Type': getMime(filepath),
      'Cache-Control': cacheControl || 'no-cache',
    };
    if (etag) headers['ETag'] = etag;
    // gzip for text-like content >1KB when client accepts it
    const ae = req && req.headers && req.headers['accept-encoding'] || '';
    const compressible = /\.(json|html|js|css|txt|md|xml|svg|vtt)$/i.test(filepath);
    // Representation varies by Accept-Encoding → any shared cache (reverse
    // proxy) must key on it, or a gzip body could be served to an
    // identity-only client.
    if (compressible) headers['Vary'] = 'Accept-Encoding';
    if (data.length > 1024 && ae.includes('gzip') && compressible) {
      const zlib = require('zlib');
      zlib.gzip(data, (e, compressed) => {
        if (e) { headers['Content-Length'] = data.length; res.writeHead(200, headers); res.end(data); return; }
        headers['Content-Encoding'] = 'gzip';
        headers['Content-Length'] = compressed.length;
        res.writeHead(200, headers);
        res.end(compressed);
      });
    } else {
      headers['Content-Length'] = data.length;
      res.writeHead(200, headers);
      res.end(data);
    }
  });
}

// Range-aware file serving for audio/video (supports seeking)
const MEDIA_EXTS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.mp4', '.webm']);
function serveFileWithRange(req, res, filepath, cacheControl) {
  try {
    const stat = fs.statSync(filepath);
    const mime = getMime(filepath);
    // Media files are archived-once and effectively immutable; a validator lets
    // the browser reuse its cached copy instead of re-pulling 100MB+ audio over
    // the WAN on every listen (the old blanket no-store forbade even that).
    const lastMod = stat.mtime.toUTCString();
    // Honour If-Range: if the validator doesn't match, fall through to a full
    // 200 — serving a 206 slice of a changed entity would corrupt playback.
    const ifRange = req.headers['if-range'];
    const range = (!ifRange || ifRange === lastMod) ? req.headers.range : null;
    if (range) {
      const m = range.match(/bytes=(\d+)-(\d*)/);
      if (m) {
        const start = parseInt(m[1]);
        let end = m[2] ? parseInt(m[2]) : stat.size - 1;
        if (end >= stat.size) end = stat.size - 1; // clamp ranges past EOF (e.g. bytes=0-999999999) so headers match bytes sent
        // Unsatisfiable: start past EOF, or a reversed range (bytes=100-50)
        // which would otherwise yield a negative Content-Length.
        if (start >= stat.size || end < start) {
          res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
          res.end();
          return;
        }
        const chunkSize = end - start + 1;
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunkSize,
          'Content-Type': mime,
          'Cache-Control': cacheControl || 'no-cache',
          'Last-Modified': lastMod,
        });
        streamTo(res, filepath, { start, end });
        return;
      }
    }
    if (!req.headers.range && req.headers['if-modified-since'] === lastMod) {
      res.writeHead(304, { 'Last-Modified': lastMod, 'Cache-Control': cacheControl || 'no-cache' });
      res.end();
      return;
    }
    // No (usable) Range header - serve full file with Accept-Ranges
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': stat.size,
      'Accept-Ranges': 'bytes',
      'Cache-Control': cacheControl || 'no-cache',
      'Last-Modified': lastMod,
    });
    streamTo(res, filepath);
  } catch (e) {
    if (e.code === 'ENOENT') { res.writeHead(404); res.end('Not found'); }
    else { console.error(`Read error: ${filepath}`, e.message); res.writeHead(500); res.end('Read error'); }
  }
}

function jsonReply(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

// Read a request body with a hard size cap so an (authenticated) client can't
// OOM the single-process server with an unbounded upload. On overflow we stop
// buffering and resolve a sentinel; callers JSON.parse it, which throws and is
// already handled as a 400/500 in every handler.
const MAX_BODY_BYTES = 4 * 1024 * 1024; // 4MB — generous for article edits
function readBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0, aborted = false;
    req.on('data', c => {
      if (aborted) return;
      size += c.length;
      if (size > maxBytes) { aborted = true; chunks.length = 0; resolve('__BODY_TOO_LARGE__'); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!aborted) resolve(Buffer.concat(chunks).toString('utf-8')); });
    req.on('error', () => { if (!aborted) resolve(''); });
  });
}

// ── Request handler ──────────────────────────────────
// The async handler is wrapped so ANY throw inside a request (sync fs call
// outside a try, unexpected state) becomes a logged 500 instead of an
// unhandledRejection — one bad request must never take the process down.
const server = http.createServer((req, res) => {
  _handleRequest(req, res).catch((e) => {
    console.error('[server] handler error:', (e && e.stack) || e);
    try {
      if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('Internal error'); }
      else res.destroy();
    } catch {}
  });
});

async function _handleRequest(req, res) {
  // Use URL path before any '?' query separator, but for /vault/ paths
  // we need the raw URL since filenames may contain literal '?' characters.
  const rawUrl = req.url;
  let pathname;
  try {
    const parsed = url.parse(rawUrl);
    pathname = decodeURIComponent(parsed.pathname);
    if (rawUrl.startsWith('/vault/')) {
      const hashIdx = rawUrl.indexOf('#');
      const fullPath = hashIdx >= 0 ? rawUrl.slice(0, hashIdx) : rawUrl;
      pathname = decodeURIComponent(fullPath);
    }
  } catch (e) {
    res.writeHead(400); res.end('Bad request URI');
    return;
  }

  // /api/auth - always accessible (login endpoint), rate-limited
  if (pathname === '/api/auth' && req.method === 'POST') {
    const ip = _clientIp(req);
    if (_rateLimitAuth(ip)) {
      jsonReply(res, 429, { ok: false, error: '尝试过于频繁，请稍后再试' });
      return;
    }
    const body = await readBody(req);
    try {
      const { password } = JSON.parse(body);
      const a = Buffer.from(String(password || ''), 'utf-8');
      const b = Buffer.from(String(config.password || ''), 'utf-8');
      const ok = a.length === b.length && b.length > 0 && crypto.timingSafeEqual(a, b);
      if (ok) {
        // Successful auth resets the failure counter
        _authFails.delete(ip);
        const token = makeToken();
        // Secure only when the original request was HTTPS (we're behind a
        // TLS-terminating proxy); left unset for direct localhost/LAN HTTP.
        const secure = _reqIsHttps(req) ? '; Secure' : '';
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': `or_token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${secure}`,
        });
        res.end(JSON.stringify({ ok: true }));
      } else {
        jsonReply(res, 401, { ok: false, error: '密码错误' });
      }
    } catch {
      jsonReply(res, 400, { ok: false, error: 'Bad request' });
    }
    return;
  }

  // /api/check-auth - check if auth is needed and if current session is valid
  if (pathname === '/api/check-auth') {
    jsonReply(res, 200, {
      needsAuth: !!config.password,
      authed: isAuthed(req),
    });
    return;
  }

  // Static assets (index.html, JS, CSS) always accessible for login page to work
  // But protect /vault/*, /data/*, /api/rescan, /api/config
  const isProtectedPath = pathname.startsWith('/vault/') ||
    pathname.startsWith('/data/') ||
    pathname.startsWith('/tts-cache/') ||
    pathname === '/api/tts' ||
    pathname === '/api/rescan' ||
    pathname === '/api/config' ||
    pathname === '/api/password' ||
    pathname === '/api/note' ||
    pathname === '/api/note/delete' ||
    pathname === '/api/note/edit' ||
    pathname === '/api/notes' ||
    pathname === '/api/transcribe' ||
    pathname === '/api/transcribe/status' ||
    pathname === '/api/align' ||
    pathname === '/api/events' ||
    pathname === '/api/read-state' ||
    pathname === '/api/read-state/add' ||
    pathname === '/api/read-state/remove' ||
    pathname === '/api/stats/heartbeat' ||
    pathname === '/api/stats/summary';

  if (isProtectedPath && !isAuthed(req)) {
    jsonReply(res, 401, { error: 'Unauthorized' });
    return;
  }

  // /api/events - SSE stream for live updates (per-IP cap + heartbeat)
  if (pathname === '/api/events') {
    const ip = _clientIp(req);
    const cur = _sseConnsByIp.get(ip) || 0;
    if (cur >= SSE_MAX_PER_IP) {
      jsonReply(res, 429, { error: 'Too many SSE connections' });
      return;
    }
    _sseConnsByIp.set(ip, cur + 1);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write('data: connected\n\n');
    sseClients.add(res);
    const hb = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { cleanup(); }
    }, 30000);
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(hb);
      sseClients.delete(res);
      const left = (_sseConnsByIp.get(ip) || 1) - 1;
      if (left <= 0) _sseConnsByIp.delete(ip);
      else _sseConnsByIp.set(ip, left);
    };
    req.on('close', cleanup);
    req.on('error', cleanup);
    res.on('error', cleanup);
    return;
  }

  // /tts-cache/* → serve generated TTS audio (with Range support for seeking)
  if (pathname.startsWith('/tts-cache/')) {
    const rel = pathname.slice(11);
    const resolved = path.resolve(TTS_CACHE, rel);
    if (!isInside(TTS_CACHE, resolved)) {
      res.writeHead(403); res.end('Forbidden');
      return;
    }
    // Range-aware serving shared with /vault media. This block used to be a
    // ~45-line line-for-line copy of serveFileWithRange (bugfixes had to be
    // pasted twice, and once already were); now it's the same code path.
    serveFileWithRange(req, res, resolved, 'max-age=604800');
    return;
  }

  // /api/tts - generate TTS audio for article (with concurrency dedup)
  if (pathname === '/api/tts' && req.method === 'POST') {
    const body = await readBody(req);
    let parsed;
    try { parsed = JSON.parse(body); }
    catch { jsonReply(res, 400, { ok: false, error: 'Bad request' }); return; }
    const { text, id, voice } = parsed;
    if (!text || !id) {
      jsonReply(res, 400, { ok: false, error: 'Missing text or id' });
      return;
    }
    // Reject oversized text early (edge-tts argv limit ~256KB on macOS)
    if (Buffer.byteLength(text, 'utf-8') > TTS_MAX_TEXT_BYTES) {
      jsonReply(res, 413, { ok: false, error: '文本过长，请分段（>100KB）' });
      return;
    }
    const hash = crypto.createHash('md5').update(text).digest('hex').slice(0, 12);
    const safeId = String(id).replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 60);
    const baseName = `${safeId}_${hash}`;
    const mp3Path = path.join(TTS_CACHE, baseName + '.mp3');
    const vttPath = path.join(TTS_CACHE, baseName + '.vtt');

    if (fs.existsSync(mp3Path) && fs.existsSync(vttPath)) {
      jsonReply(res, 200, {
        ok: true, audio: '/tts-cache/' + baseName + '.mp3',
        subtitle: '/tts-cache/' + baseName + '.vtt', cached: true
      });
      return;
    }
    try {
      fs.mkdirSync(TTS_CACHE, { recursive: true });
    } catch (e) {
      jsonReply(res, 500, { ok: false, error: 'TTS cache dir unavailable: ' + e.message });
      return;
    }

    // Dedup: if a generation for this baseName is in flight, await it
    let pending = _ttsInProgress.get(baseName);
    if (!pending) {
      const useVoice = voice || TTS_VOICE;
      pending = new Promise((resolve) => {
        execFile(PYTHON, [
          '-m', 'edge_tts',
          '--voice', useVoice,
          '--text', text,
          '--write-media', mp3Path,
          '--write-subtitles', vttPath
        ], { timeout: 120000, maxBuffer: 10 * 1024 * 1024 }, (err, _stdout, stderr) => {
          if (err) resolve({ ok: false, error: stderr || err.message });
          else resolve({ ok: true });
        });
      }).finally(() => _ttsInProgress.delete(baseName));
      _ttsInProgress.set(baseName, pending);
    }
    const out = await pending;
    if (!out.ok) {
      console.error('[tts] generation failed:', out.error);
      jsonReply(res, 500, { ok: false, error: 'TTS generation failed', detail: String(out.error || '').slice(-300) });
      return;
    }
    jsonReply(res, 200, {
      ok: true, audio: '/tts-cache/' + baseName + '.mp3',
      subtitle: '/tts-cache/' + baseName + '.vtt', cached: false
    });
    return;
  }

  // /api/note - POST save a highlight note
  if (pathname === '/api/note' && req.method === 'POST') {
    if (!isAuthed(req)) { jsonReply(res, 401, { error: 'Unauthorized' }); return; }
    const body = await readBody(req);
    try {
      const { articleId, quote, note } = JSON.parse(body);
      if (!articleId || !quote) {
        jsonReply(res, 400, { ok: false, error: 'Missing articleId or quote' });
        return;
      }
      if (!config.vault) {
        jsonReply(res, 500, { ok: false, error: 'Vault not configured' });
        return;
      }
      // Resolve article directory
      const articlePath = path.resolve(config.vault, articleId);
      if (!isInside(config.vault, articlePath)) {
        jsonReply(res, 403, { ok: false, error: 'Forbidden' });
        return;
      }
      const articleDir = path.dirname(articlePath);
      const notePath = path.join(articleDir, '笔记.md');
      // Get article title from filename
      const articleTitle = path.basename(articleId, '.md');
      // No date recording per user preference
      // Build note entry in new grouped-by-article format
      let existingContent = '';
      try { existingContent = fs.readFileSync(notePath, 'utf-8'); } catch {}
      const sectionHeader = '## [[' + articleTitle + ']]';
      // Build the individual entry (without section header)
      let item = '\n---\n\n';
      item += '> ' + quote.replace(/\n/g, '\n> ') + '\n\n';
      if (note && note.trim()) {
        item += note.trim() + '\n';
      }
      if (existingContent.includes(sectionHeader)) {
        // Find the section and append the entry at its end
        // Section ends at next ## [[ or end of file
        const sectionIdx = existingContent.indexOf(sectionHeader);
        // Find next section header after this one
        const afterHeader = sectionIdx + sectionHeader.length;
        const nextSectionMatch = existingContent.slice(afterHeader).search(/\n## \[\[/);
        if (nextSectionMatch >= 0) {
          // Insert before the next section
          const insertPos = afterHeader + nextSectionMatch;
          const newContent = existingContent.slice(0, insertPos) + item + existingContent.slice(insertPos);
          atomicWriteSync(notePath, newContent);
        } else {
          // Append at end of file
          atomicWriteSync(notePath, existingContent + item);
        }
      } else {
        // New section: append section header + entry
        let newSection = '\n' + sectionHeader + '\n' + item;
        atomicWriteSync(notePath, existingContent + newSection);
      }
      jsonReply(res, 200, { ok: true });
    } catch (e) {
      console.error('[note] error:', e.message);
      jsonReply(res, 500, { ok: false, error: 'Failed to save note: ' + e.message });
    }
    return;
  }

  // /api/note/delete — POST delete a highlight/note entry
  if (pathname === '/api/note/delete' && req.method === 'POST') {
    if (!isAuthed(req)) { jsonReply(res, 401, { error: 'Unauthorized' }); return; }
    const body = await readBody(req);
    try {
      const { articleId, quote } = JSON.parse(body);
      if (!articleId || !quote) {
        jsonReply(res, 400, { ok: false, error: 'Missing articleId or quote' });
        return;
      }
      if (!config.vault) {
        jsonReply(res, 500, { ok: false, error: 'Vault not configured' });
        return;
      }
      const articlePath = path.resolve(config.vault, articleId);
      if (!isInside(config.vault, articlePath)) {
        jsonReply(res, 403, { ok: false, error: 'Forbidden' });
        return;
      }
      const articleDir = path.dirname(articlePath);
      const notePath = path.join(articleDir, '笔记.md');
      if (!fs.existsSync(notePath)) {
        jsonReply(res, 404, { ok: false, error: 'Notes file not found' });
        return;
      }
      const content = fs.readFileSync(notePath, 'utf-8');
      const normalizedQuote = normQuote(quote);
      const entries = content.split(/^---\s*$/m);
      let found = false;
      const kept = [];
      for (const entry of entries) {
        const trimmed = entry.trim();
        if (!trimmed) continue;
        const quoteLines = trimmed.split('\n').filter(l => l.trim().startsWith('> '));
        const blockQuote = normQuote(quoteLines.map(l => l.trim().replace(/^>\s?/, '')).join(' '));
        if (blockQuote && normalizedQuote === blockQuote) {
          found = true;
          continue;
        }
        kept.push(trimmed);
      }
      if (!found) {
        jsonReply(res, 404, { ok: false, error: 'Matching entry not found' });
        return;
      }
      // Rebuild: filter out empty section headers (## lines with no entries after them)
      const rebuilt = [];
      for (let i = 0; i < kept.length; i++) {
        const k = kept[i];
        // If it's a section header and the next entry is also a header (or end), skip it
        if (/^##\s+\[\[/.test(k) && !k.includes('\n> ')) {
          const next = kept[i + 1];
          if (!next || /^##\s+\[\[/.test(next)) continue;
        }
        rebuilt.push(k);
      }
      if (!rebuilt.length) {
        fs.unlinkSync(notePath);
      } else {
        // Rebuild file: section headers get newline before, entries get --- before
        let out = '';
        for (const block of rebuilt) {
          if (/^##\s+\[\[/.test(block)) {
            out += (out ? '\n' : '') + block + '\n';
          } else {
            out += '\n---\n\n' + block + '\n';
          }
        }
        atomicWriteSync(notePath, out.trim() + '\n');
      }
      jsonReply(res, 200, { ok: true });
    } catch (e) {
      console.error('[note/delete] error:', e.message);
      jsonReply(res, 500, { ok: false, error: 'Failed to delete note: ' + e.message });
    }
    return;
  }

  // /api/note/edit — POST edit note content for a highlight entry
  if (pathname === '/api/note/edit' && req.method === 'POST') {
    if (!isAuthed(req)) { jsonReply(res, 401, { error: 'Unauthorized' }); return; }
    const body = await readBody(req);
    try {
      const { articleId, quote, newNote } = JSON.parse(body);
      if (!articleId || !quote) {
        jsonReply(res, 400, { ok: false, error: 'Missing articleId or quote' });
        return;
      }
      if (!config.vault) {
        jsonReply(res, 500, { ok: false, error: 'Vault not configured' });
        return;
      }
      const articlePath = path.resolve(config.vault, articleId);
      if (!isInside(config.vault, articlePath)) {
        jsonReply(res, 403, { ok: false, error: 'Forbidden' });
        return;
      }
      const articleDir = path.dirname(articlePath);
      const notePath = path.join(articleDir, '笔记.md');
      if (!fs.existsSync(notePath)) {
        jsonReply(res, 404, { ok: false, error: 'Notes file not found' });
        return;
      }
      const content = fs.readFileSync(notePath, 'utf-8');
      const normalizedQuote = normQuote(quote);
      const entries = content.split(/^---\s*$/m);
      let found = false;
      const kept = [];
      for (const entry of entries) {
        const trimmed = entry.trim();
        if (!trimmed) continue;
        const quoteLines = trimmed.split('\n').filter(l => l.trim().startsWith('> '));
        const blockQuote = normQuote(quoteLines.map(l => l.trim().replace(/^>\s?/, '')).join(' '));
        if (blockQuote && normalizedQuote === blockQuote && !found) {
          found = true;
          // Rebuild: keep quote, replace note, keep metadata lines
          const lines = trimmed.split('\n');
          const rebuiltLines = [];
          let pastQuote = false;
          for (const line of lines) {
            const lt = line.trim();
            if (lt.startsWith('> ') || lt === '>') {
              rebuiltLines.push(line);
              pastQuote = true;
            } else if (lt.match(/^\*.*\*$/) || lt.match(/^##\s/)) {
              // Metadata line (*date* or *—— [[title]]...*) or section header — keep
              if (pastQuote && newNote && newNote.trim()) {
                rebuiltLines.push('');
                rebuiltLines.push(newNote.trim());
                rebuiltLines.push('');
                pastQuote = false; // note inserted
              }
              rebuiltLines.push(line);
            } else if (!pastQuote) {
              rebuiltLines.push(line);
            }
            // else: skip old note content
          }
          // If no metadata line was found, append note at end
          if (pastQuote && newNote && newNote.trim()) {
            rebuiltLines.push('');
            rebuiltLines.push(newNote.trim());
          }
          kept.push(rebuiltLines.join('\n'));
        } else {
          kept.push(trimmed);
        }
      }
      if (!found) {
        jsonReply(res, 404, { ok: false, error: 'Matching entry not found' });
        return;
      }
      // Rebuild file
      let out = '';
      for (const block of kept) {
        if (/^##\s+\[\[/.test(block)) {
          out += (out ? '\n' : '') + block + '\n';
        } else {
          out += '\n---\n\n' + block + '\n';
        }
      }
      atomicWriteSync(notePath, out.trim() + '\n');
      jsonReply(res, 200, { ok: true });
    } catch (e) {
      console.error('[note/edit] error:', e.message);
      jsonReply(res, 500, { ok: false, error: 'Failed to edit note: ' + e.message });
    }
    return;
  }

  // /api/notes — GET notes/highlights for an article
  if (pathname === '/api/notes' && req.method === 'GET') {
    if (!isAuthed(req)) { jsonReply(res, 401, { error: 'Unauthorized' }); return; }
    const qs = new url.URL(req.url, 'http://localhost').searchParams;
    const articleId = qs.get('articleId');
    if (!articleId) {
      jsonReply(res, 400, { ok: false, error: 'Missing articleId' });
      return;
    }
    if (!config.vault) {
      jsonReply(res, 500, { ok: false, error: 'Vault not configured' });
      return;
    }
    const articlePath = path.resolve(config.vault, articleId);
    if (!isInside(config.vault, articlePath)) {
      jsonReply(res, 403, { ok: false, error: 'Forbidden' });
      return;
    }
    const articleDir = path.dirname(articlePath);
    const notePath = path.join(articleDir, '笔记.md');
    const articleTitle = path.basename(articleId, '.md');
    try {
      if (!fs.existsSync(notePath)) {
        jsonReply(res, 200, { ok: true, notes: [] });
        return;
      }
      const content = fs.readFileSync(notePath, 'utf-8');
      const entries = parseNotesFile(content, articleTitle);
      jsonReply(res, 200, { ok: true, notes: entries });
    } catch (e) {
      console.error('[notes] error:', e.message);
      jsonReply(res, 500, { ok: false, error: 'Failed to read notes: ' + e.message });
    }
    return;
  }

  // /api/read-state — GET read ids + per-id timestamps + tombstones (for LWW merge)
  if (pathname === '/api/read-state' && req.method === 'GET') {
    const reads = {}, tombs = {};
    for (const [id, ts] of _reads) reads[id] = ts;
    for (const [id, ts] of _tombstones) tombs[id] = ts;
    jsonReply(res, 200, { ok: true, articles: _readList(), reads, tombstones: tombs });
    return;
  }

  // /api/read-state/add — POST { id|ids, ts? }  (mark read; LWW by ts)
  if (pathname === '/api/read-state/add' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const data = JSON.parse(body);
      const ids = Array.isArray(data.ids) ? data.ids : (data.id ? [data.id] : []);
      const ts = Number(data.ts) || Date.now();
      let changed = 0;
      for (const id of ids) {
        if (typeof id !== 'string' || !id) continue;
        if (ts >= (_reads.get(id) || 0)) { _reads.set(id, ts); changed++; }
      }
      if (changed) _persistReadState();
      jsonReply(res, 200, { ok: true, added: changed, total: _readList().length });
    } catch {
      jsonReply(res, 400, { ok: false, error: 'Bad request' });
    }
    return;
  }

  // /api/read-state/remove — POST { id|ids, ts? }  (tombstone unmark; LWW by ts)
  if (pathname === '/api/read-state/remove' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const data = JSON.parse(body);
      const ids = Array.isArray(data.ids) ? data.ids : (data.id ? [data.id] : []);
      const ts = Number(data.ts) || Date.now();
      let changed = 0;
      for (const id of ids) {
        if (typeof id !== 'string' || !id) continue;
        if (ts >= (_tombstones.get(id) || 0)) { _tombstones.set(id, ts); changed++; }
      }
      if (changed) _persistReadState();
      jsonReply(res, 200, { ok: true, removed: changed, total: _readList().length });
    } catch {
      jsonReply(res, 400, { ok: false, error: 'Bad request' });
    }
    return;
  }

  // /api/stats/heartbeat — POST { entries: [{ id, readMs, listenMs }] }
  // Deltas accumulated client-side; also the sendBeacon target on page hide.
  if (pathname === '/api/stats/heartbeat' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const data = JSON.parse(body);
      const entries = Array.isArray(data.entries) ? data.entries : [];
      let applied = 0;
      for (const e of entries.slice(0, 50)) {
        if (!e || typeof e.id !== 'string' || !e.id || e.id.length > 512) continue;
        const r = Math.min(Math.max(Number(e.readMs) || 0, 0), STATS_MAX_DELTA_MS);
        const l = Math.min(Math.max(Number(e.listenMs) || 0, 0), STATS_MAX_DELTA_MS);
        if (r < 1 && l < 1) continue;
        _addStatsDelta(e.id, Math.round(r), Math.round(l));
        applied++;
      }
      if (applied) _scheduleStatsFlush();
      jsonReply(res, 200, { ok: true, applied });
    } catch {
      jsonReply(res, 400, { ok: false, error: 'Bad request' });
    }
    return;
  }

  // /api/stats/summary — everything the stats page renders, in one call
  if (pathname === '/api/stats/summary' && req.method === 'GET') {
    try {
      jsonReply(res, 200, _buildStatsSummary());
    } catch (e) {
      console.error('[stats] summary failed:', e.message);
      jsonReply(res, 500, { ok: false, error: 'summary failed' });
    }
    return;
  }

  // /api/transcribe - POST transcribe audio file with Qwen3-ASR (qwen_vtt.py)
  // Tracks in-progress transcriptions to avoid duplicate work.
  // {force:true} re-transcribes even when a VTT exists (legacy whisper-era
  // VTT upgrade); the old VTT is backed up under archive/vtt-backups/ first —
  // whisper-era VTTs are irreproducible (the whisper models are gone).
  if (pathname === '/api/transcribe' && req.method === 'POST') {
    if (!isAuthed(req)) { jsonReply(res, 401, { error: 'Unauthorized' }); return; }
    const body = await readBody(req);
    try {
      const { audioPath, force } = JSON.parse(body);
      if (!audioPath) {
        jsonReply(res, 400, { ok: false, error: 'Missing audioPath' });
        return;
      }
      if (!config.vault) {
        jsonReply(res, 500, { ok: false, error: 'Vault not configured' });
        return;
      }
      const resolved = resolveVaultPath(audioPath);
      if (!resolved) {
        jsonReply(res, 404, { ok: false, error: 'Audio file not found' });
        return;
      }
      const vttRelative = path.relative(config.vault, resolved.replace(/\.[^.]+$/, '.vtt'));
      const status = _startTranscription(resolved, { force: !!force });
      if (status === 'cached') jsonReply(res, 200, { ok: true, vttPath: vttRelative, cached: true });
      else if (status === 'in_progress') jsonReply(res, 200, { ok: true, status: 'in_progress', vttPath: vttRelative });
      else if (status === 'busy') jsonReply(res, 503, { ok: false, error: '转写队列已满，请稍后再试' });
      else jsonReply(res, 202, { ok: true, status, vttPath: vttRelative }); // 'started' | 'queued'
    } catch (e) {
      console.error('[transcribe] error:', e.message);
      jsonReply(res, 500, { ok: false, error: 'Transcription failed: ' + e.message });
    }
    return;
  }

  // /api/transcribe/status - POST check transcription status
  if (pathname === '/api/transcribe/status' && req.method === 'POST') {
    if (!isAuthed(req)) { jsonReply(res, 401, { error: 'Unauthorized' }); return; }
    const body = await readBody(req);
    try {
      const { audioPath } = JSON.parse(body);
      if (!audioPath || !config.vault) {
        jsonReply(res, 400, { ok: false, error: 'Missing audioPath' });
        return;
      }
      const resolved = resolveVaultPath(audioPath);
      // Try to find VTT (may exist even when audio doesn't, after rename); fall back to deriving from audio
      const vttResolved = resolveVaultPath(audioPath.replace(/\.[^.]+$/, '.vtt'))
        || (resolved ? resolved.replace(/\.[^.]+$/, '.vtt') : null);
      const vttRelative = vttResolved ? path.relative(config.vault, vttResolved) : null;
      // in_progress FIRST: during a force re-transcription the OLD vtt still
      // exists on disk, so the exists-check alone would falsely report 'done'.
      // 'queued' is reported distinctly: a queued job can wait up to 20 min
      // behind the running one, and the frontend must not count that wait
      // against its own transcription-time budget.
      if (resolved && _transcribeQueue.some(q => q.resolved === resolved)) {
        jsonReply(res, 200, { ok: true, status: 'queued' });
      } else if (resolved && _transcribeInProgress.has(resolved)) {
        jsonReply(res, 200, { ok: true, status: 'in_progress' });
      } else if (vttResolved && fs.existsSync(vttResolved)) {
        jsonReply(res, 200, { ok: true, status: 'done', vttPath: vttRelative });
      } else {
        jsonReply(res, 200, { ok: true, status: 'not_started' });
      }
    } catch (e) {
      jsonReply(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  // /api/align - POST semantic alignment using embedding model
  // Returns {segMap, segTimeRanges, stats} or cached result
  if (pathname === '/api/align' && req.method === 'POST') {
    if (!isAuthed(req)) { jsonReply(res, 401, { error: 'Unauthorized' }); return; }
    const body = await readBody(req);
    try {
      const { articleId, vttPath, segments } = JSON.parse(body);
      if (!articleId || !vttPath || !config.vault) {
        jsonReply(res, 400, { ok: false, error: 'Missing articleId or vttPath' });
        return;
      }
      // Frontend-supplied DOM segments (collectArticleSegments) — when present,
      // align.py uses them verbatim so the count always matches the browser.
      const domSegments = (Array.isArray(segments) && segments.every(s => typeof s === 'string'))
        ? segments : null;
      const articleResolved = path.resolve(config.vault, articleId);
      const vttResolved = resolveVaultPath(vttPath);
      if (!isInside(config.vault, articleResolved)) {
        jsonReply(res, 403, { ok: false, error: 'Forbidden' });
        return;
      }
      if (!fs.existsSync(articleResolved) || !vttResolved) {
        jsonReply(res, 404, { ok: false, error: 'File not found' });
        return;
      }
      // Legacy (whisper-era) VTT: tell the client and lazily queue a background
      // re-transcription so a later activation gets clean subtitles + a fresh
      // alignment (the new VTT's mtime invalidates the cache naturally).
      const legacyVtt = _isLegacyVtt(vttResolved);
      const retranscribing = legacyVtt ? _autoRetranscribeLegacy(vttResolved) : false;

      // Cache: check for .align.json next to VTT
      const cachePath = vttResolved.replace(/\.vtt$/i, '.align.json');
      if (fs.existsSync(cachePath)) {
        try {
          const cacheMtime = fs.statSync(cachePath).mtimeMs;
          const articleMtime = fs.statSync(articleResolved).mtimeMs;
          const vttMtime = fs.statSync(vttResolved).mtimeMs;
          const cached = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
          const st = cached.stats || {};
          const ver = alignVersion();
          let fresh = cacheMtime > articleMtime && cacheMtime > vttMtime;
          if (!fresh && st.mdHash && st.vttHash
              && sha1File(articleResolved) === st.mdHash && sha1File(vttResolved) === st.vttHash) {
            // mtime went stale but the CONTENT didn't change (iCloud touch,
            // bulk re-sync): adopt the cache and refresh its mtime instead of
            // burning a full realign.
            try { const now = new Date(); fs.utimesSync(cachePath, now, now); } catch {}
            console.log('[align] mtime stale but content unchanged, keeping cache:', path.basename(cachePath));
            fresh = true;
          }
          // hotwords.json feeds apply_hotwords() inside align.py, so an edited
          // hotword table must invalidate caches too — the typical reason to
          // add a hotword is "this article aligns badly", which by definition
          // already has a cache that would otherwise swallow the change.
          if (fresh) {
            let hotwordsMtime = 0;
            try { hotwordsMtime = fs.statSync(path.join(DIR, 'hotwords.json')).mtimeMs; } catch {}
            if (hotwordsMtime && cacheMtime <= hotwordsMtime) {
              fresh = false;
              console.log('[align] hotwords.json newer than cache, regenerating:', path.basename(cachePath));
            }
          }
          if (!fresh) {
            console.log('[align] cache stale, regenerating:', cachePath);
          } else if ((st.version || 0) !== ver) {
            // Self-heal (1): version mismatch (align.py logic changed)
            console.log(`[align] cache version=${st.version || 0} (current=${ver}), regenerating: ${cachePath}`);
          } else if (domSegments && st.segments !== domSegments.length) {
            // Self-heal (2): segment count differs from the browser's current
            // DOM count (e.g. dist/collectArticleSegments changed, or an old
            // parse_segments-based cache). Regenerate from DOM segments so the
            // frontend won't reject it and fall back to LCS.
            console.log(`[align] cache segCount=${st.segments} != DOM ${domSegments.length}, regenerating: ${cachePath}`);
          } else if (!st.segments || !st.cues) {
            // Legitimately empty article or empty VTT (nothing to align) —
            // version matches, so accept the empty map instead of pointlessly
            // regenerating it on every request.
            cached.cached = true;
            jsonReply(res, 200, { ok: true, legacyVtt, retranscribing, ...cached });
            return;
          } else {
            // Self-heal (3): low quality — but only ONCE per inputs. The
            // algorithm is deterministic, so if a regeneration confirmed the
            // low ratio (lowQualityConfirmed) a further re-run on identical
            // inputs can't do better and would just burn ~10s + an iCloud
            // cache rewrite on every open.
            const { hitRatio, effSegments } = _alignQuality(cached);
            if (hitRatio < 0.7 && !st.lowQualityConfirmed) {
              console.log(`[align] cache low-quality (segsHit=${st.segsHit}/${effSegments} eff, ratio=${hitRatio.toFixed(2)}), regenerating once: ${cachePath}`);
            } else {
              cached.cached = true;
              jsonReply(res, 200, { ok: true, legacyVtt, retranscribing, ...cached });
              return;
            }
          }
        } catch (e) { /* cache corrupted or stat failed, regenerate */ }
      }
      // Generate — deduped across concurrent requests for the same cache file
      // (two devices opening the same article used to double-run the model and
      // could interleave a non-atomic cache write into a truncated JSON).
      let job = _alignInFlight.get(cachePath);
      if (!job) {
        job = _generateAlignment(articleResolved, vttResolved, cachePath, domSegments)
          .then(() => {
            // If the FRESH result is still low-quality, stamp it confirmed so
            // the cache check above accepts it from now on (see self-heal (3)).
            try {
              const result = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
              const { hitRatio, effSegments } = _alignQuality(result);
              if (hitRatio < 0.7 && result.stats) {
                console.log(`[align] fresh result low-quality (ratio=${hitRatio.toFixed(2)}, eff=${effSegments}) — confirming to stop the regen loop: ${path.basename(cachePath)}`);
                result.stats.lowQualityConfirmed = true;
                const tmp = cachePath + '.tmp-annotate';
                fs.writeFileSync(tmp, JSON.stringify(result));
                fs.renameSync(tmp, cachePath);
              }
            } catch {}
          })
          .finally(() => _alignInFlight.delete(cachePath));
        _alignInFlight.set(cachePath, job);
      }
      await job;
      const result = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
      jsonReply(res, 200, { ok: true, legacyVtt, retranscribing, ...result });
    } catch (e) {
      console.error('[align] error:', e.message);
      jsonReply(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  // /data/* → serve catalog data (ETag-based caching)
  if (pathname.startsWith('/data/')) {
    const rel = pathname.slice(6);
    const resolved = path.resolve(DIST, 'data', rel);
    if (!isInside(path.join(DIST, 'data'), resolved)) {
      res.writeHead(403); res.end('Forbidden');
      return;
    }
    // ETag support for catalog.json
    try {
      const stat = fs.statSync(resolved);
      const etag = '"' + stat.mtimeMs.toString(36) + '-' + stat.size.toString(36) + '"';
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { 'ETag': etag });
        res.end();
        return;
      }
      serveFile(res, resolved, 'no-cache', req, etag);
    } catch {
      serveFile(res, resolved, 'no-cache', req);
    }
    return;
  }

  // /vault/* → GET: serve from vault; POST: write markdown back
  if (pathname.startsWith('/vault/')) {
    const rel = pathname.slice(7);
    const directResolved = path.resolve(config.vault, rel);
    if (!isInside(config.vault, directResolved)) {
      res.writeHead(403); res.end('Forbidden');
      return;
    }

    // POST /vault/* - write markdown content (no basename fallback for writes)
    if (req.method === 'POST') {
      // Only allow writing .md files
      if (!directResolved.toLowerCase().endsWith('.md')) {
        jsonReply(res, 400, { ok: false, error: 'Only .md files can be edited' });
        return;
      }
      // Ensure file exists (don't create new files via this endpoint)
      if (!fs.existsSync(directResolved)) {
        jsonReply(res, 404, { ok: false, error: 'File not found' });
        return;
      }
      const body = await readBody(req);
      try {
        const { content } = JSON.parse(body);
        if (typeof content !== 'string') {
          jsonReply(res, 400, { ok: false, error: 'Missing content field' });
          return;
        }
        atomicWriteSync(directResolved, content);
        // Trigger rescan so catalog stays in sync
        scheduleRescan('edit: ' + rel);
        jsonReply(res, 200, { ok: true });
      } catch (e) {
        jsonReply(res, 500, { ok: false, error: 'Write failed: ' + e.message });
      }
      return;
    }

    // GET: try direct path, then Obsidian-style basename fallback
    const resolved = fs.existsSync(directResolved) ? directResolved : resolveVaultPath(rel);
    if (!resolved) {
      res.writeHead(404); res.end('Not found');
      return;
    }
    // Use Range-aware streaming for audio/video (enables seeking). Media is
    // archive-once/immutable — let the browser cache it for a day (validated
    // via Last-Modified/If-Range in serveFileWithRange) instead of re-pulling
    // 100MB+ audio over the WAN on every listen. Text (.md etc.) stays
    // no-store below: it's small and the user edits it.
    if (MEDIA_EXTS.has(path.extname(resolved).toLowerCase())) {
      serveFileWithRange(req, res, resolved, 'private, max-age=86400');
    } else {
      serveFile(res, resolved, 'no-store, no-cache, must-revalidate', req);
    }
    return;
  }

  // /api/rescan → regenerate catalog (POST only: it has a side effect + spawns
  // a process, so it must not be triggerable by a GET/prefetch). Routed through
  // doRescan so it shares the in-flight mutex + changed-only broadcast.
  if (pathname === '/api/rescan' && req.method === 'POST') {
    doRescan('api-rescan', (ok, stdout, stderr) => {
      jsonReply(res, ok ? 200 : 500, { ok, stdout: (stdout || '').slice(-500), stderr: (stderr || '').slice(-500) });
    });
    return;
  }

  // /api/password - POST change password
  // When no password is set, only loopback may initialize one (prevents
  // any LAN visitor from racing to claim the password on a fresh install).
  if (pathname === '/api/password' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const { oldPassword, newPassword } = JSON.parse(body);
      if (!config.password) {
        // Must be physically local — check the raw socket, not _clientIp (which
        // honours X-Forwarded-For) so a forged header can't fake loopback.
        if (!_isDirectLoopback(req)) {
          jsonReply(res, 403, { ok: false, error: '初次设置密码必须在本机（127.0.0.1）操作' });
          return;
        }
      } else {
        // Has password: must supply correct old password (timing-safe)
        const a = Buffer.from(String(oldPassword || ''), 'utf-8');
        const b = Buffer.from(String(config.password), 'utf-8');
        const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
        if (!ok) {
          jsonReply(res, 401, { ok: false, error: '原密码错误' });
          return;
        }
      }
      config.password = newPassword || '';
      saveConfig(config);
      // Rotate session secret → all outstanding tokens become invalid
      rotateSessionSecret();
      if (config.password) {
        const token = makeToken();
        const secure = _reqIsHttps(req) ? '; Secure' : '';
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': `or_token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${secure}`,
        });
        res.end(JSON.stringify({ ok: true, msg: newPassword ? '密码已更新' : '密码已关闭' }));
      } else {
        jsonReply(res, 200, { ok: true, msg: '密码已关闭' });
      }
    } catch {
      jsonReply(res, 400, { ok: false, error: 'Bad request' });
    }
    return;
  }

  // /api/config - GET current config, POST update vault path
  if (pathname === '/api/config') {
    if (req.method === 'GET') {
      jsonReply(res, 200, { vault: config.vault, ttsEnabled: config.ttsEnabled === true });
      return;
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      try {
        const parsed = JSON.parse(body);
        let changed = false;
        let vaultChanged = false;
        if (parsed.vault && typeof parsed.vault === 'string') {
          // Validate: must be an existing directory and not the filesystem root.
          // Without this, a caller could point the vault at '/' and then
          // read/write the whole filesystem through /vault/* (isInside('/', …)
          // is always true).
          let okDir = false;
          try { okDir = fs.statSync(parsed.vault).isDirectory(); } catch {}
          if (!okDir || path.resolve(parsed.vault) === path.parse(path.resolve(parsed.vault)).root) {
            jsonReply(res, 400, { ok: false, error: 'vault 必须是一个已存在的目录（且不能是根目录）' });
            return;
          }
          if (parsed.vault !== config.vault) vaultChanged = true;
          config.vault = parsed.vault;
          changed = true;
        }
        if (typeof parsed.ttsEnabled === 'boolean') {
          config.ttsEnabled = parsed.ttsEnabled;
          changed = true;
        }
        if (changed) {
          saveConfig(config);
          // Re-point the live machinery at the new vault, otherwise the watcher
          // and auto-rescan keep tracking the OLD path until the next restart.
          if (vaultChanged) {
            invalidateBasenameIndex();
            startWatching(config.vault);
            scheduleRescan('config-change');
          }
          jsonReply(res, 200, { ok: true, vault: config.vault, ttsEnabled: config.ttsEnabled === true });
        } else {
          jsonReply(res, 400, { ok: false, error: 'No valid fields provided' });
        }
      } catch {
        jsonReply(res, 400, { ok: false, error: 'Bad request' });
      }
      return;
    }
  }

  // Everything else → serve from dist/
  let filepath = path.join(DIST, pathname === '/' ? 'index.html' : pathname);
  const resolved = path.resolve(filepath);
  if (!isInside(DIST, resolved)) {
    res.writeHead(403); res.end('Forbidden');
    return;
  }

  fs.stat(resolved, (err, stat) => {
    if (err || !stat.isFile()) {
      if (!path.extname(pathname)) {
        serveFile(res, path.join(DIST, 'index.html'), 'no-cache', req);
      } else {
        res.writeHead(404); res.end('Not found');
      }
      return;
    }
    // index.html / sw.js / manifest must not be pinned in the HTTP cache:
    // both the SW's stale-while-revalidate refetch and its install-time
    // precache read through the HTTP cache, so a max-age'd index.html made
    // fresh deploys lag up to an hour and could even bake the OLD shell into
    // a NEW SW cache version ("修了没生效"). no-cache + the ETag below means
    // revalidation is a cheap 304, not a full re-download.
    const cc = /(?:^|\/)(index\.html|sw\.js|manifest\.webmanifest)$/.test(resolved) ? 'no-cache' : 'max-age=3600';
    const etag = '"' + stat.mtimeMs.toString(36) + '-' + stat.size.toString(36) + '"';
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { 'ETag': etag, 'Cache-Control': cc, 'Vary': 'Accept-Encoding' });
      res.end();
      return;
    }
    // NB: passing req enables the gzip branch in serveFile — the old call left
    // it undefined, so dist files (196KB index.html) always went out raw.
    serveFile(res, resolved, cc, req, etag);
  });
}

// ── SSE: push catalog updates to connected browsers ──
const sseClients = new Set();

// ── Auto-rescan: watch vault for changes ─────────────
let _rescanTimer = null;
let _watcher = null;

// In-flight mutex: watcher debounce, the 5-min safety net, /api/rescan and
// startup are mutually unaware entry points; two concurrent scan.py runs used
// to race on catalog.json. While one runs, further requests coalesce into a
// single queued follow-up.
let _scanRunning = false;
let _scanPending = null; // { reason, cbs: [] }
const CATALOG_PATH = path.join(DIST, 'data', 'catalog.json');

function doRescan(reason, cb) {
  if (_scanRunning) {
    if (!_scanPending) _scanPending = { reason, cbs: [] };
    else _scanPending.reason = reason;
    if (cb) _scanPending.cbs.push(cb);
    return;
  }
  _scanRunning = true;
  let beforeMtime = 0;
  try { beforeMtime = fs.statSync(CATALOG_PATH).mtimeMs; } catch {}
  execFile(PYTHON, [path.join(DIR, 'scan.py')], { timeout: 30000 }, (err, stdout, stderr) => {
    _scanRunning = false;
    const ok = !err;
    // Broadcast only when the catalog actually changed (scan.py skips the
    // write when content is identical, so mtime is a reliable signal). The
    // old unconditional broadcast made every client refetch ~900KB and
    // rebuild the whole sidebar every 5 minutes, 24/7.
    // The mtime compare runs even on error: a scan killed by the 30s timeout
    // AFTER its atomic os.replace still updated the catalog, and the next
    // (successful) run would report "unchanged" — clients would never hear
    // about the change otherwise.
    let afterMtime = 0;
    try { afterMtime = fs.statSync(CATALOG_PATH).mtimeMs; } catch {}
    const changed = afterMtime !== beforeMtime;
    if (changed) {
      for (const client of sseClients) {
        try { client.write(`data: catalog-updated\n\n`); } catch {}
      }
    }
    if (!ok) {
      console.error(`[auto-rescan] failed (${reason})${changed ? ' [catalog did change — broadcast sent]' : ''}:`, stderr || err.message);
    } else {
      console.log(`[auto-rescan] OK (${reason}) - catalog ${changed ? 'updated' : 'unchanged'}`);
    }
    if (cb) { try { cb(ok, stdout, stderr); } catch {} }
    if (_scanPending) {
      const p = _scanPending;
      _scanPending = null;
      const chained = p.cbs.length
        ? (ok2, so, se) => { for (const f of p.cbs) { try { f(ok2, so, se); } catch {} } }
        : undefined;
      doRescan(p.reason, chained);
    }
  });
}

function scheduleRescan(reason) {
  // Debounce: wait 2s after last change before rescanning
  if (_rescanTimer) clearTimeout(_rescanTimer);
  _rescanTimer = setTimeout(() => {
    _rescanTimer = null;
    doRescan(reason);
  }, 2000);
}

let _safetyRescan = null;
function startWatching(vaultPath) {
  if (_watcher) { try { _watcher.close(); } catch {} }
  if (_safetyRescan) clearInterval(_safetyRescan);
  // Called on startup and on vault change — memoized absolute paths would
  // otherwise keep pointing (validly!) into the OLD vault after a switch.
  _basenameHits.clear();
  if (!vaultPath) return;
  try {
    _watcher = fs.watch(vaultPath, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      invalidateBasenameIndex();
      // Precise memo invalidation only — wholesale-clearing the hit memo here
      // would defeat it exactly when iCloud fires event storms during sync.
      // Stale entries additionally self-heal via the existsSync check on hit.
      _basenameHits.delete(_basenameKey(path.basename(String(filename))));
      const ext = path.extname(filename).toLowerCase();
      const isDir = !ext;
      if (ext === '.md' || isDir) {
        scheduleRescan(`${eventType}: ${filename}`);
      }
    });
    _watcher.on('error', (err) => {
      console.error('[vault-watch] error:', err.message);
    });
    console.log(`👁️  Watching vault for changes (recursive)`);
  } catch (err) {
    console.error('[vault-watch] could not start:', err.message);
  }
  // Safety net: iCloud Drive sometimes drops fsevents on placeholder downloads.
  // Re-scan unconditionally every 5 minutes so a missed event self-heals.
  _safetyRescan = setInterval(() => doRescan('safety-net'), 5 * 60 * 1000);
}

// ── TTS cache cleanup: remove .mp3/.vtt pairs older than 7 days ──
// Group by basename so a half-stale pair (only mp3 expired) gets the .vtt
// removed too — otherwise next request thinks cache is incomplete and
// triggers a wasteful regen.
function cleanTTSCache() {
  try {
    if (!fs.existsSync(TTS_CACHE)) return;
    const now = Date.now();
    const maxAge = 7 * 24 * 60 * 60 * 1000;
    const groups = new Map(); // baseName → {mp3?:path, vtt?:path, oldest:mtime}
    for (const f of fs.readdirSync(TTS_CACHE)) {
      if (!/\.(mp3|vtt)$/i.test(f)) continue;
      const fp = path.join(TTS_CACHE, f);
      let st; try { st = fs.statSync(fp); } catch { continue; }
      if (!st.isFile()) continue;
      const base = f.replace(/\.(mp3|vtt)$/i, '');
      const ext = f.slice(-3).toLowerCase();
      const g = groups.get(base) || { oldest: Infinity };
      g[ext] = fp;
      g.oldest = Math.min(g.oldest, st.mtimeMs);
      groups.set(base, g);
    }
    let cleaned = 0;
    for (const [, g] of groups) {
      if (now - g.oldest <= maxAge) continue;
      for (const k of ['mp3', 'vtt']) {
        if (g[k]) { try { fs.unlinkSync(g[k]); cleaned++; } catch {} }
      }
    }
    if (cleaned) console.log(`[tts-cache] cleaned ${cleaned} expired files (>7d)`);
  } catch (e) {
    console.error('[tts-cache] cleanup error:', e.message);
  }
}

// Normalize a quote for comparison: strip whitespace + most punctuation,
// fold fullwidth → half, lowercase. Used across save/delete/edit/parse so a
// trivial whitespace difference doesn't cause "matching entry not found".
function normQuote(s) {
  if (!s) return '';
  return String(s)
    .replace(/[\s　 ]+/g, '')
    .replace(/[，。！？；："'`'""'']/g, '')
    .replace(/[,.!?;:'"`]/g, '')
    .toLowerCase();
}

// ── Parse 笔记.md file into structured entries ─────
// Supports both new format (grouped by ## [[title]]) and old format (*—— [[title]]，date*)
function parseNotesFile(content, filterTitle) {
  const entries = [];
  // Detect if new format is present: ## [[...]] section headers
  const hasSections = /^## \[\[.+?\]\]/m.test(content);
  if (hasSections) {
    // New format: split by ## [[title]] headers
    // Each section starts with ## [[title]] and contains entries separated by ---
    const sectionRegex = /^## \[\[(.+?)\]\]/gm;
    const sectionStarts = [];
    let m;
    while ((m = sectionRegex.exec(content)) !== null) {
      sectionStarts.push({ title: m[1].trim(), index: m.index, headerEnd: m.index + m[0].length });
    }
    for (let si = 0; si < sectionStarts.length; si++) {
      const sec = sectionStarts[si];
      const sectionEnd = si + 1 < sectionStarts.length ? sectionStarts[si + 1].index : content.length;
      const sectionBody = content.slice(sec.headerEnd, sectionEnd);
      const sectionTitle = sec.title;
      // Filter by article title
      if (filterTitle && sectionTitle !== filterTitle) continue;
      // Split section body by --- separator
      const blocks = sectionBody.split(/\n---\s*\n/);
      for (const block of blocks) {
        const trimmed = block.trim();
        if (!trimmed) continue;
        const parsed = parseNoteBlock(trimmed, sectionTitle);
        if (parsed) entries.push(parsed);
      }
    }
    // Also parse any content before the first section header (might be old-format entries)
    if (sectionStarts.length > 0 && sectionStarts[0].index > 0) {
      const preamble = content.slice(0, sectionStarts[0].index);
      const oldEntries = parseOldFormatBlocks(preamble, filterTitle);
      entries.push(...oldEntries);
    }
  } else {
    // Old format only: entries separated by --- with *—— [[title]]，date* lines
    const oldEntries = parseOldFormatBlocks(content, filterTitle);
    entries.push(...oldEntries);
  }
  return entries;
}

// Parse a single note block (new format: no *—— [[title]]* line, date is standalone *date*)
function parseNoteBlock(trimmed, sectionTitle) {
  const lines = trimmed.split('\n');
  let quote = '';
  let note = '';
  let date = '';
  let inQuote = false;
  let afterQuote = false;
  for (const line of lines) {
    const l = line.trim();
    if (l.startsWith('> ') || l === '>') {
      inQuote = true;
      afterQuote = false;
      quote += (quote ? '\n' : '') + l.replace(/^>\s?/, '');
    } else if (inQuote && !afterQuote && l === '') {
      afterQuote = true;
    } else if (l.match(/^\*——\s*\[\[(.+?)\]\].*\*$/)) {
      // Old-format source line found in a section block — extract date from it
      const m = l.match(/^\*——\s*\[\[(.+?)\]\][,，]\s*(.+?)\*$/);
      if (m) date = m[2].trim();
    } else if (l.match(/^\*\d{4}-\d{2}-\d{2}\*$/)) {
      // New format date line: *2025-05-04*
      date = l.replace(/^\*|\*$/g, '').trim();
    } else if (afterQuote && l && !l.startsWith('*')) {
      note += (note ? '\n' : '') + l;
    }
  }
  if (!quote) return null;
  return { quote: quote.trim(), note: note.trim(), date, articleTitle: sectionTitle };
}

// Parse old-format blocks (with *—— [[title]]，date* lines)
function parseOldFormatBlocks(content, filterTitle) {
  const entries = [];
  const blocks = content.split(/\n---\s*\n/);
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    const lines = trimmed.split('\n');
    let quote = '';
    let note = '';
    let date = '';
    let linkedTitle = '';
    let inQuote = false;
    let afterQuote = false;
    for (const line of lines) {
      const l = line.trim();
      if (l.startsWith('> ') || l === '>') {
        inQuote = true;
        afterQuote = false;
        quote += (quote ? '\n' : '') + l.replace(/^>\s?/, '');
      } else if (inQuote && !afterQuote && l === '') {
        afterQuote = true;
      } else if (l.match(/^\*——\s*\[\[(.+?)\]\].*\*$/)) {
        const m = l.match(/^\*——\s*\[\[(.+?)\]\][,，]\s*(.+?)\*$/);
        if (m) {
          linkedTitle = m[1].trim();
          date = m[2].trim();
        } else {
          const m2 = l.match(/^\*——\s*\[\[(.+?)\]\].*\*$/);
          if (m2) linkedTitle = m2[1].trim();
        }
      } else if (afterQuote && l && !l.startsWith('*')) {
        note += (note ? '\n' : '') + l;
      }
    }
    if (!quote) continue;
    if (filterTitle && linkedTitle && linkedTitle !== filterTitle) continue;
    entries.push({ quote: quote.trim(), note: note.trim(), date, articleTitle: linkedTitle });
  }
  return entries;
}

const PORT = config.port || 8765;
// Default to loopback (never 0.0.0.0) when bind is absent — consistent with the
// safe default in loadConfig(), so a config that exists but omits `bind` can't
// silently expose the vault on every interface. A real LAN/proxy deployment
// sets `bind` explicitly (e.g. "0.0.0.0" or the LAN IP).
const BIND = config.bind || '127.0.0.1';
server.listen(PORT, BIND, () => {
  console.log(`🚀 Obsidian Reader server on ${BIND}:${PORT}`);
  console.log(`   Dist: ${DIST}`);
  console.log(`   Vault: ${config.vault}`);
  console.log(`   Auth: ${config.password ? 'enabled' : 'disabled'}`);
  // Start watching vault
  startWatching(config.vault);
  // Clean expired TTS cache on startup
  cleanTTSCache();
  // Initial rescan on startup (serve.sh scan may fail if iCloud not ready)
  setTimeout(() => doRescan('startup'), 3000);
});
