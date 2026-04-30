#!/usr/bin/env node
/**
 * Obsidian Reader — lightweight HTTP server (Node.js)
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
const { execFile } = require('child_process');
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
const validTokens = new Set();

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

function jsonReply(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', c => d += c);
    req.on('end', () => resolve(d));
  });
}

// ── Request handler ──────────────────────────────────
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url);
  const pathname = decodeURIComponent(parsed.pathname);

  // /api/auth — always accessible (login endpoint)
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

  // /api/check-auth — check if auth is needed and if current session is valid
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
    pathname === '/api/password';

  if (isProtectedPath && !isAuthed(req)) {
    jsonReply(res, 401, { error: 'Unauthorized' });
    return;
  }

  // /api/events — SSE stream for live updates
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

  // /tts-cache/* → serve generated TTS audio
  if (pathname.startsWith('/tts-cache/')) {
    const rel = pathname.slice(11);
    const resolved = path.resolve(TTS_CACHE, rel);
    if (!resolved.startsWith(path.resolve(TTS_CACHE))) {
      res.writeHead(403); res.end('Forbidden');
      return;
    }
    serveFile(res, resolved, 'max-age=3600');
    return;
  }

  // /api/tts — generate TTS audio for article
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

  // /vault/* → serve from Obsidian vault
  if (pathname.startsWith('/vault/')) {
    const rel = pathname.slice(7);
    const resolved = path.resolve(config.vault, rel);
    if (!resolved.startsWith(path.resolve(config.vault))) {
      res.writeHead(403); res.end('Forbidden');
      return;
    }
    serveFile(res, resolved, 'no-store, no-cache, must-revalidate');
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

  // /api/password — POST change password
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

  // /api/config — GET current config, POST update vault path
  if (pathname === '/api/config') {
    if (req.method === 'GET') {
      jsonReply(res, 200, { vault: config.vault });
      return;
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      try {
        const { vault } = JSON.parse(body);
        if (vault && typeof vault === 'string') {
          config.vault = vault;
          saveConfig(config);
          jsonReply(res, 200, { ok: true, vault: config.vault });
        } else {
          jsonReply(res, 400, { ok: false, error: 'Invalid vault path' });
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
      console.log(`[auto-rescan] OK (${reason}) — catalog updated`);
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
      // Only care about .md file changes and directory renames
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

const PORT = config.port || 8765;
const BIND = config.bind || '0.0.0.0';
server.listen(PORT, BIND, () => {
  console.log(`🚀 Obsidian Reader server on ${BIND}:${PORT}`);
  console.log(`   Dist: ${DIST}`);
  console.log(`   Vault: ${config.vault}`);
  console.log(`   Auth: ${config.password ? 'enabled' : 'disabled'}`);
  // Start watching vault
  startWatching(config.vault);
  // Initial rescan on startup (serve.sh scan may fail if iCloud not ready)
  setTimeout(() => doRescan('startup'), 3000);
});
