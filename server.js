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

// ── Auth ─────────────────────────────────────────────
// Simple token-based auth: client sends password, gets a session token stored in cookie
const SESSION_SECRET = crypto.randomBytes(32).toString('hex');
const _transcribeInProgress = new Set();
const validTokens = new Set();

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
  const vaultAbs = path.resolve(config.vault);
  const direct = path.resolve(config.vault, rel);
  if (!direct.startsWith(vaultAbs)) return null;
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

function makeToken() {
  const t = crypto.randomBytes(24).toString('hex');
  validTokens.add(t);
  return t;
}

function isAuthed(req) {
  if (!config.password) return true; // no password set = open access
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/or_token=([a-f0-9]+)/);
  return m && validTokens.has(m[1]);
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

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
  });
}

// ── Request handler ──────────────────────────────────
const server = http.createServer(async (req, res) => {
  // Use URL path before any '?' query separator, but for /vault/ paths
  // we need the raw URL since filenames may contain literal '?' characters.
  const rawUrl = req.url;
  const parsed = url.parse(rawUrl);
  let pathname = decodeURIComponent(parsed.pathname);
  // For vault paths: the filename may contain '?' which url.parse splits as query.
  // Re-derive pathname from the full raw URL for vault requests.
  if (rawUrl.startsWith('/vault/')) {
    // Strip only the hash (if any); keep everything else as pathname
    const hashIdx = rawUrl.indexOf('#');
    const fullPath = hashIdx >= 0 ? rawUrl.slice(0, hashIdx) : rawUrl;
    pathname = decodeURIComponent(fullPath);
  }

  // /api/auth - always accessible (login endpoint)
  if (pathname === '/api/auth' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const { password } = JSON.parse(body);
      if (password === config.password) {
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
    pathname === '/api/align';

  if (isProtectedPath && !isAuthed(req)) {
    jsonReply(res, 401, { error: 'Unauthorized' });
    return;
  }

  // /api/events - SSE stream for live updates
  if (pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write('data: connected\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // /tts-cache/* → serve generated TTS audio (with Range support for seeking)
  if (pathname.startsWith('/tts-cache/')) {
    const rel = pathname.slice(11);
    const resolved = path.resolve(TTS_CACHE, rel);
    if (!resolved.startsWith(path.resolve(TTS_CACHE))) {
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

  // /api/tts - generate TTS audio for article
  if (pathname === '/api/tts' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const { text, id, voice } = JSON.parse(body);
      if (!text || !id) {
        jsonReply(res, 400, { ok: false, error: 'Missing text or id' });
        return;
      }
      // Hash the text content for cache key
      const hash = crypto.createHash('md5').update(text).digest('hex').slice(0, 12);
      const safeId = id.replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 60);
      const baseName = `${safeId}_${hash}`;
      const mp3Path = path.join(TTS_CACHE, baseName + '.mp3');
      const vttPath = path.join(TTS_CACHE, baseName + '.vtt');

      // Check cache
      if (fs.existsSync(mp3Path) && fs.existsSync(vttPath)) {
        jsonReply(res, 200, {
          ok: true,
          audio: '/tts-cache/' + baseName + '.mp3',
          subtitle: '/tts-cache/' + baseName + '.vtt',
          cached: true
        });
        return;
      }

      // Ensure cache dir
      fs.mkdirSync(TTS_CACHE, { recursive: true });

      // Generate with edge-tts
      const useVoice = voice || TTS_VOICE;
      const { execFile: ef } = require('child_process');
      ef(PYTHON, [
        '-m', 'edge_tts',
        '--voice', useVoice,
        '--text', text,
        '--write-media', mp3Path,
        '--write-subtitles', vttPath
      ], { timeout: 120000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          console.error('[tts] generation failed:', stderr || err.message);
          jsonReply(res, 500, { ok: false, error: 'TTS generation failed', detail: (stderr || '').slice(-300) });
          return;
        }
        jsonReply(res, 200, {
          ok: true,
          audio: '/tts-cache/' + baseName + '.mp3',
          subtitle: '/tts-cache/' + baseName + '.vtt',
          cached: false
        });
      });
    } catch (e) {
      jsonReply(res, 400, { ok: false, error: 'Bad request' });
    }
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
      if (!articlePath.startsWith(path.resolve(config.vault))) {
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
      if (!articlePath.startsWith(path.resolve(config.vault))) {
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
      const normalizedQuote = quote.replace(/\s+/g, ' ').trim();
      // Split into entry blocks by --- (handle both start-of-file and mid-file separators)
      const entries = content.split(/^---\s*$/m);
      let found = false;
      const kept = [];
      for (const entry of entries) {
        const trimmed = entry.trim();
        if (!trimmed) continue; // empty block
        // Check if this block contains the target quote
        const quoteLines = trimmed.split('\n').filter(l => l.trim().startsWith('> '));
        const blockQuote = quoteLines.map(l => l.trim().replace(/^>\s?/, '')).join(' ').replace(/\s+/g, ' ').trim();
        if (blockQuote && normalizedQuote === blockQuote) {
          found = true;
          continue; // skip this entry
        }
        // Keep section headers (## [[title]]) even if they have no quote
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
      if (!articlePath.startsWith(path.resolve(config.vault))) {
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
      const normalizedQuote = quote.replace(/\s+/g, ' ').trim();
      // Split into entry blocks by ---
      const entries = content.split(/^---\s*$/m);
      let found = false;
      const kept = [];
      for (const entry of entries) {
        const trimmed = entry.trim();
        if (!trimmed) continue;
        const quoteLines = trimmed.split('\n').filter(l => l.trim().startsWith('> '));
        const blockQuote = quoteLines.map(l => l.trim().replace(/^>\s?/, '')).join(' ').replace(/\s+/g, ' ').trim();
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
    if (!articlePath.startsWith(path.resolve(config.vault))) {
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
      const proc = spawn('/Users/lhx/Library/Python/3.9/bin/mlx_whisper', [
        '--model', 'mlx-community/whisper-large-v3-turbo',
        '--language', 'zh',
        '--output-format', 'vtt',
        '--output-dir', outputDir,
        resolved
      ], { timeout: 600000 });
      let stderr = '';
      proc.stderr.on('data', d => stderr += d.toString());
      proc.on('close', (code) => {
        _transcribeInProgress.delete(resolved);
        if (code === 0) {
          console.log('[transcribe] OK:', audioPath);
        } else {
          console.error('[transcribe] failed:', audioPath, stderr.slice(-300));
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

  // /api/transcribe/status - GET check transcription status
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
      if (!articleResolved.startsWith(path.resolve(config.vault))) {
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
            const ALIGN_VERSION = 8;
            const cachedVer = st.version || 0;
            const hitRatio = st.segments > 0 ? (st.segsHit || 0) / st.segments : 1;
            if (cachedVer !== ALIGN_VERSION) {
              console.log(`[align] cache version=${cachedVer} (current=${ALIGN_VERSION}), regenerating: ${cachePath}`);
            } else if (hitRatio < 0.5) {
              console.log(`[align] cache low-quality (segsHit=${st.segsHit}/${st.segments}), regenerating: ${cachePath}`);
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
    if (!resolved.startsWith(path.resolve(DIST, 'data'))) {
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
    if (!directResolved.startsWith(path.resolve(config.vault))) {
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

  // /api/rescan → regenerate catalog
  if (pathname === '/api/rescan') {
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
  if (pathname === '/api/password' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const { oldPassword, newPassword } = JSON.parse(body);
      // Verify old password (or no password was set)
      if (config.password && oldPassword !== config.password) {
        jsonReply(res, 401, { ok: false, error: '原密码错误' });
        return;
      }
      config.password = newPassword || '';
      saveConfig(config);
      // Invalidate all existing tokens
      validTokens.clear();
      if (config.password) {
        // Issue a new token for the current user
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
  if (!resolved.startsWith(path.resolve(DIST))) {
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
    serveFile(res, resolved, 'max-age=3600');
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

function startWatching(vaultPath) {
  if (_watcher) { try { _watcher.close(); } catch {} }
  if (!vaultPath) return;
  try {
    _watcher = fs.watch(vaultPath, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      // Any file or directory change invalidates the basename index
      invalidateBasenameIndex();
      // Only .md changes and directory renames trigger a catalog rescan
      const ext = path.extname(filename).toLowerCase();
      const isDir = !ext; // directory events often have no extension
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
}

// ── TTS cache cleanup: remove files older than 7 days ──
function cleanTTSCache() {
  try {
    if (!fs.existsSync(TTS_CACHE)) return;
    const now = Date.now();
    const maxAge = 7 * 24 * 60 * 60 * 1000;
    let cleaned = 0;
    for (const f of fs.readdirSync(TTS_CACHE)) {
      const fp = path.join(TTS_CACHE, f);
      try {
        const st = fs.statSync(fp);
        if (st.isFile() && (now - st.mtimeMs) > maxAge) {
          fs.unlinkSync(fp);
          cleaned++;
        }
      } catch {}
    }
    if (cleaned) console.log(`[tts-cache] cleaned ${cleaned} expired files (>7d)`);
  } catch (e) {
    console.error('[tts-cache] cleanup error:', e.message);
  }
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
