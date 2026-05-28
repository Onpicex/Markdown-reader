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
    return { vault: '', port: 8765, bind: '0.0.0.0', password: '' };
  }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
}

let config = loadConfig();

// Alignment cache version — single source of truth shared with align.py via
// align-version.json. Bump it there; both sides pick it up (no more dual
// hard-coded literals drifting out of sync).
function loadAlignVersion() {
  try { return Number(JSON.parse(fs.readFileSync(path.join(DIR, 'align-version.json'), 'utf-8')).version) || 14; }
  catch { return 14; }
}
const ALIGN_VERSION = loadAlignVersion();

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
const _ttsInProgress = new Map(); // baseName → Promise of result
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
function _clientIp(req) {
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}
function _rateLimitAuth(ip) {
  const now = Date.now();
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
  const key = rel.toLowerCase();
  const tryLookup = () => {
    const hit = _basenameIndex && _basenameIndex.get(key);
    return hit ? path.resolve(config.vault, hit) : null;
  };
  if (!_basenameIndex || Date.now() - _basenameIndexBuilt > _BASENAME_MAX_AGE_MS) {
    buildBasenameIndex();
  }
  let found = tryLookup();
  if (found) return found;
  // Second chance: rebuild if cache is older than min-rebuild and retry once
  // (handles the case where a VTT/file was just created)
  if (Date.now() - _basenameIndexBuilt > _BASENAME_MIN_REBUILD_MS) {
    buildBasenameIndex();
    found = tryLookup();
  }
  return found;
}

function isAuthed(req) {
  if (!config.password) return true; // no password set = open access
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
      'Access-Control-Allow-Origin': '*',
    };
    if (etag) headers['ETag'] = etag;
    // gzip for text-like content >1KB when client accepts it
    const ae = req && req.headers && req.headers['accept-encoding'] || '';
    if (data.length > 1024 && ae.includes('gzip') && /\.(json|html|js|css|txt|md|xml|svg|vtt)$/i.test(filepath)) {
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
    const range = req.headers.range;
    if (range) {
      const m = range.match(/bytes=(\d+)-(\d*)/);
      if (m) {
        const start = parseInt(m[1]);
        const end = m[2] ? parseInt(m[2]) : stat.size - 1;
        if (start >= stat.size) {
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
          'Access-Control-Allow-Origin': '*',
        });
        fs.createReadStream(filepath, { start, end }).pipe(res);
        return;
      }
    }
    // No Range header - serve full file with Accept-Ranges
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': stat.size,
      'Accept-Ranges': 'bytes',
      'Cache-Control': cacheControl || 'no-cache',
      'Access-Control-Allow-Origin': '*',
    });
    fs.createReadStream(filepath).pipe(res);
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
const server = http.createServer(async (req, res) => {
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
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': `or_token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`,
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
    pathname === '/api/read-state/remove';

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
      'Access-Control-Allow-Origin': '*',
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
    // Range request support for audio seeking
    try {
      const stat = fs.statSync(resolved);
      const mime = getMime(resolved);
      const range = req.headers.range;
      if (range) {
        const m = range.match(/bytes=(\d+)-(\d*)/);
        if (m) {
          const start = parseInt(m[1]);
          const end = m[2] ? parseInt(m[2]) : stat.size - 1;
          if (start >= stat.size) {
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
            'Cache-Control': 'max-age=604800',
          });
          fs.createReadStream(resolved, { start, end }).pipe(res);
          return;
        }
      }
      // No Range header - serve full file with Accept-Ranges
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': stat.size,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'max-age=604800',
      });
      fs.createReadStream(resolved).pipe(res);
    } catch (e) {
      if (e.code === 'ENOENT') { res.writeHead(404); res.end('Not found'); }
      else { res.writeHead(500); res.end('Read error'); }
    }
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
    fs.mkdirSync(TTS_CACHE, { recursive: true });

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
          fs.writeFileSync(notePath, newContent, 'utf-8');
        } else {
          // Append at end of file
          fs.appendFileSync(notePath, item, 'utf-8');
        }
      } else {
        // New section: append section header + entry
        let newSection = '\n' + sectionHeader + '\n' + item;
        fs.appendFileSync(notePath, newSection, 'utf-8');
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
        fs.writeFileSync(notePath, out.trim() + '\n', 'utf-8');
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
      fs.writeFileSync(notePath, out.trim() + '\n', 'utf-8');
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

  // /api/transcribe - POST transcribe audio file with mlx-whisper
  // Tracks in-progress transcriptions to avoid duplicate work
  if (pathname === '/api/transcribe' && req.method === 'POST') {
    if (!isAuthed(req)) { jsonReply(res, 401, { error: 'Unauthorized' }); return; }
    const body = await readBody(req);
    try {
      const { audioPath } = JSON.parse(body);
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
      // VTT output path: same dir, same name, .vtt extension
      const vttPath = resolved.replace(/\.[^.]+$/, '.vtt');
      const vttRelative = path.relative(config.vault, vttPath);
      // If VTT already exists, return immediately
      if (fs.existsSync(vttPath)) {
        jsonReply(res, 200, { ok: true, vttPath: vttRelative, cached: true });
        return;
      }
      // Check if transcription is already in progress
      if (_transcribeInProgress.has(resolved)) {
        jsonReply(res, 200, { ok: true, status: 'in_progress', vttPath: vttRelative });
        return;
      }
      // Start transcription asynchronously
      _transcribeInProgress.add(resolved);
      const outputDir = path.dirname(resolved);
      const mlxBin = config.mlxWhisperBin || process.env.MLX_WHISPER_BIN || 'mlx_whisper';
      // mlx_whisper writes output as <stem-before-first-dot>.vtt when the
      // input stem contains dots (e.g. "19.0726丨03 初段-闭环...mp3" →
      // "19.vtt", clobbering siblings). Use a dot-free temp stem via
      // --output-name then rename. Same workaround as the central generator
      // at ~/.hermes/scripts/openclaw_generate_audio_vtt.py.
      const tmpStem = 'ocw_vtt_' + crypto.randomBytes(4).toString('hex');
      const tmpVtt = path.join(outputDir, tmpStem + '.vtt');
      // Anti-hallucination flags, kept in sync with the central VTT generator
      // at ~/.hermes/scripts/openclaw_generate_audio_vtt.py — see that file
      // for rationale on each flag. Summary: --word-timestamps + max-words
      // -per-line splits any 30s mega-cue from repetition loops into short
      // cues; --hallucination-silence-threshold skips long silence;
      // --compression-ratio-threshold tightens fallback.
      const proc = spawn(mlxBin, [
        '--model', 'mlx-community/whisper-large-v3-turbo',
        '--language', 'zh',
        '--output-format', 'vtt',
        '--condition-on-previous-text', 'False',
        '--word-timestamps', 'True',
        '--max-words-per-line', '8',
        '--hallucination-silence-threshold', '2',
        '--compression-ratio-threshold', '2.0',
        '--output-dir', outputDir,
        '--output-name', tmpStem,
        resolved
      ], { timeout: 600000 });
      let stderr = '';
      proc.stderr.on('data', d => stderr += d.toString());
      proc.on('close', (code) => {
        _transcribeInProgress.delete(resolved);
        if (code === 0) {
          try {
            if (fs.existsSync(tmpVtt)) {
              if (fs.existsSync(vttPath)) fs.unlinkSync(vttPath);
              fs.renameSync(tmpVtt, vttPath);
              console.log('[transcribe] OK:', audioPath);
            } else {
              console.error('[transcribe] OK exit but tmp vtt missing:', tmpVtt);
            }
          } catch (e) {
            console.error('[transcribe] rename failed:', e.message);
          }
        } else {
          console.error('[transcribe] failed:', audioPath, stderr.slice(-300));
          try { if (fs.existsSync(tmpVtt)) fs.unlinkSync(tmpVtt); } catch {}
        }
      });
      proc.on('error', (err) => {
        _transcribeInProgress.delete(resolved);
        console.error('[transcribe] spawn error:', err.message);
      });
      jsonReply(res, 202, { ok: true, status: 'started', vttPath: vttRelative });
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
      if (vttResolved && fs.existsSync(vttResolved)) {
        jsonReply(res, 200, { ok: true, status: 'done', vttPath: vttRelative });
      } else if (resolved && _transcribeInProgress.has(resolved)) {
        jsonReply(res, 200, { ok: true, status: 'in_progress' });
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
      const { articleId, vttPath } = JSON.parse(body);
      if (!articleId || !vttPath || !config.vault) {
        jsonReply(res, 400, { ok: false, error: 'Missing articleId or vttPath' });
        return;
      }
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
      // Cache: check for .align.json next to VTT
      // Invalidate if article or VTT is newer than cache
      const cachePath = vttResolved.replace(/\.vtt$/i, '.align.json');
      if (fs.existsSync(cachePath)) {
        try {
          const cacheMtime = fs.statSync(cachePath).mtimeMs;
          const articleMtime = fs.statSync(articleResolved).mtimeMs;
          const vttMtime = fs.statSync(vttResolved).mtimeMs;
          if (cacheMtime > articleMtime && cacheMtime > vttMtime) {
            const cached = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
            // Self-healing:
            //  (1) version mismatch (align.py logic changed) → regenerate
            //  (2) low quality (<50% of segments hit by any cue) → regenerate
            const st = cached.stats || {};
            const cachedVer = st.version || 0;
            // Bonus credit for segments that don't appear in audio (footnotes,
            // 划重点 summary lists) — they correctly stay unmapped. Without
            // this, articles with many footnotes look "low quality" and
            // regenerate forever. Heuristic: unmapped tail (>15% of segments
            // at audio_end) is treated as expected-non-spoken.
            const tr = cached.segTimeRanges || [];
            let tailUnmapped = 0;
            if (tr.length) {
              const audioEnd = tr[tr.length - 1].end;
              for (let i = tr.length - 1; i >= 0; i--) {
                if (Math.abs(tr[i].start - audioEnd) < 0.01 && Math.abs(tr[i].end - audioEnd) < 0.01) tailUnmapped++;
                else break;
              }
            }
            const effSegments = Math.max(1, st.segments - tailUnmapped);
            const hitRatio = (st.segsHit || 0) / effSegments;
            if (cachedVer !== ALIGN_VERSION) {
              console.log(`[align] cache version=${cachedVer} (current=${ALIGN_VERSION}), regenerating: ${cachePath}`);
            } else if (!st.segments || !st.cues) {
              // Legitimately empty article or empty VTT (nothing to align) —
              // version matches, so accept the empty map instead of pointlessly
              // regenerating it (and re-spawning python) on every request. The
              // hitRatio heuristic below is only meaningful when cues exist.
              cached.cached = true;
              jsonReply(res, 200, { ok: true, ...cached });
              return;
            } else if (hitRatio < 0.7) {
              console.log(`[align] cache low-quality (segsHit=${st.segsHit}/${effSegments} eff, ratio=${hitRatio.toFixed(2)}), regenerating: ${cachePath}`);
            } else {
              cached.cached = true;
              jsonReply(res, 200, { ok: true, ...cached });
              return;
            }
          } else {
            console.log('[align] cache stale, regenerating:', cachePath);
          }
        } catch (e) { /* cache corrupted or stat failed, regenerate */ }
      }
      // Run align.py
      const alignScript = path.join(DIR, 'align.py');
      const proc = spawn(PYTHON, [alignScript, articleResolved, vttResolved, cachePath], {
        timeout: 60000,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
      });
      let stderr = '';
      proc.stderr.on('data', d => stderr += d.toString());
      proc.on('close', (code) => {
        if (code === 0 && fs.existsSync(cachePath)) {
          try {
            const result = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
            jsonReply(res, 200, { ok: true, ...result });
          } catch (e) {
            jsonReply(res, 500, { ok: false, error: 'Failed to read alignment result' });
          }
        } else {
          console.error('[align] failed:', stderr.slice(-500));
          jsonReply(res, 500, { ok: false, error: 'Alignment failed: ' + stderr.slice(-200) });
        }
      });
      proc.on('error', (err) => {
        console.error('[align] spawn error:', err.message);
        jsonReply(res, 500, { ok: false, error: 'Spawn failed: ' + err.message });
      });
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
        res.writeHead(304, { 'ETag': etag, 'Access-Control-Allow-Origin': '*' });
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
        fs.writeFileSync(directResolved, content, 'utf-8');
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
    // Use Range-aware streaming for audio/video (enables seeking)
    if (MEDIA_EXTS.has(path.extname(resolved).toLowerCase())) {
      serveFileWithRange(req, res, resolved, 'no-store, no-cache, must-revalidate');
    } else {
      serveFile(res, resolved, 'no-store, no-cache, must-revalidate', req);
    }
    return;
  }

  // /api/rescan → regenerate catalog (POST only: it has a side effect + spawns
  // a process, so it must not be triggerable by a GET/prefetch)
  if (pathname === '/api/rescan' && req.method === 'POST') {
    execFile(PYTHON, [path.join(DIR, 'scan.py')], { timeout: 30000 }, (err, stdout, stderr) => {
      const ok = !err;
      if (ok) {
        for (const client of sseClients) {
          try { client.write(`data: catalog-updated\n\n`); } catch {}
        }
      }
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
        const ip = _clientIp(req);
        const isLoopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
        if (!isLoopback) {
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
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': `or_token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`,
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
        if (parsed.vault && typeof parsed.vault === 'string') {
          config.vault = parsed.vault;
          changed = true;
        }
        if (typeof parsed.ttsEnabled === 'boolean') {
          config.ttsEnabled = parsed.ttsEnabled;
          changed = true;
        }
        if (changed) {
          saveConfig(config);
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
        serveFile(res, path.join(DIST, 'index.html'), 'no-cache');
      } else {
        res.writeHead(404); res.end('Not found');
      }
      return;
    }
    // sw.js / manifest must not be pinned in the HTTP cache, or service-worker
    // updates (and the shell precache list) would lag by up to an hour.
    const cc = /(?:^|\/)(sw\.js|manifest\.webmanifest)$/.test(resolved) ? 'no-cache' : 'max-age=3600';
    serveFile(res, resolved, cc);
  });
});

// ── SSE: push catalog updates to connected browsers ──
const sseClients = new Set();

// ── Auto-rescan: watch vault for changes ─────────────
let _rescanTimer = null;
let _watcher = null;

function doRescan(reason) {
  execFile(PYTHON, [path.join(DIR, 'scan.py')], { timeout: 30000 }, (err, stdout, stderr) => {
    if (err) {
      console.error(`[auto-rescan] failed (${reason}):`, stderr || err.message);
    } else {
      console.log(`[auto-rescan] OK (${reason}) - catalog updated`);
      // Notify all connected browsers
      for (const client of sseClients) {
        try { client.write(`data: catalog-updated\n\n`); } catch {}
      }
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
  if (!vaultPath) return;
  try {
    _watcher = fs.watch(vaultPath, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      invalidateBasenameIndex();
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
const BIND = config.bind || '0.0.0.0';
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
