# Obsidian Reader

[中文文档](README.zh-CN.md)

A lightweight web reader for an Obsidian vault. It scans Markdown files into a
catalog, serves the original vault files through a small Node.js backend, and
renders them in a single-page browser app.

This repository's default README is intentionally in English. Runtime secrets and
machine-specific values belong in `config.json`, which is ignored by git.

## What It Does

- Mirrors an Obsidian vault directory structure in a browser sidebar.
- Renders Markdown on demand with `marked.js`.
- Supports Obsidian wiki links such as `[[Page]]` and embedded media such as
  `![[file.mp3]]`, `![[image.png]]`, and `![[video.mp4]]`.
- Tracks read/unread state with sidebar checkmarks and persistent storage.
- Syncs read state across devices with last-write-wins timestamps and tombstones,
  so "unread" actions do not get resurrected by stale clients.
- Provides article search from the sidebar.
- Includes font-size controls, light/dark/eye-care themes, and mobile layout
  support.
- Offers password protection with a one-year HTTP-only cookie session.
- Lets authenticated users update the vault path and TTS setting from the UI.
- Supports manual rescans and automatic vault-change rescans.
- Ships PWA metadata and a service worker for an installable app shell.
- Expands first-level categories by default while deeper levels remain collapsed.
- Provides optional TTS and MP3 subtitle-following features when enabled.

## Current Local Deployment

These values describe the active local deployment on this machine. They are not
required defaults for every clone.

| Item | Value |
| --- | --- |
| Project path | `/Users/lhx/.openclaw/workspace/obsidian-reader` |
| Vault path | `/Users/lhx/Library/Mobile Documents/iCloud~md~obsidian/Documents/Openclaw` |
| LaunchAgent label | `com.obsidian-reader` |
| Port | `8765` |
| Bind address | `0.0.0.0` |
| LAN URL | `http://192.168.x.x:8765` |
| Alignment cache version | `14` |
| TTS | Disabled in `config.json` |

## Repository Layout

```text
obsidian-reader/
├── server.js                 # Node.js HTTP backend and vault proxy
├── scan.py                   # Markdown vault scanner, writes catalog.json
├── align.py                  # MP3/VTT to article paragraph alignment
├── align-version.json        # Shared alignment cache version
├── serve.sh                  # scan-then-start launch script
├── config.example.json       # safe config template
├── config.json               # local config, ignored by git
├── read-articles.json        # read-state store, ignored by git
└── dist/
    ├── index.html            # single-page frontend app
    ├── sw.js                 # PWA service worker
    ├── manifest.webmanifest
    ├── data/catalog.json     # generated catalog, ignored by git
    └── vendor/
        ├── marked.min.js
        ├── purify.min.js
        └── html2canvas.min.js
```

## Runtime Requirements

Required:

- Node.js 18 or newer
- Python 3

Optional:

- `edge-tts`, only needed when TTS is enabled.
- `mlx-whisper`, only needed for local MP3 transcription on Apple Silicon.
- `sentence-transformers`, only needed for semantic alignment fallback quality.

Install optional Python tools only if you use those features:

```bash
pip install edge-tts
pip install mlx-whisper
pip install sentence-transformers
```

The frontend dependencies are vendored in `dist/vendor/`; no frontend build step
is required.

## Configuration

Create a local config from the template:

```bash
cp config.example.json config.json
```

Example:

```json
{
  "vault": "/path/to/your/obsidian/vault",
  "port": 8765,
  "bind": "127.0.0.1",
  "trustedProxies": [],
  "password": "your-secure-password",
  "ttsEnabled": false
}
```

Fields:

| Field | Meaning |
| --- | --- |
| `vault` | Absolute path to the Obsidian vault. |
| `port` | HTTP port. Defaults to `8765` when config is missing. |
| `bind` | Bind address. Use `127.0.0.1` for local-only access, or `0.0.0.0` / a LAN IP for LAN reverse-proxy access. Missing config safely falls back to `127.0.0.1`. |
| `trustedProxies` | Optional reverse-proxy IP/CIDR allowlist. Use this when serving through nginx, Caddy, Synology reverse proxy, Cloudflare Tunnel, or similar. |
| `password` | Browser access password. Empty string disables password protection. Initial password setup without an existing password is allowed only from direct loopback. |
| `ttsEnabled` | Shows TTS controls only when explicitly `true`. Default behavior is off. |
| `mlxWhisperBin` | Optional path to the `mlx_whisper` executable. |

Do not commit `config.json`. It may contain a vault path, password, private LAN
details, or deployment-specific proxy settings.

## Start Locally

Run:

```bash
./serve.sh
```

`serve.sh` performs one scan first, then starts `server.js`.

Open:

```text
http://localhost:8765
```

If your config uses a different port, use that port instead.

## macOS LaunchAgent

The current local deployment uses a LaunchAgent:

```text
~/Library/LaunchAgents/com.obsidian-reader.plist
```

Useful commands:

```bash
launchctl print gui/$(id -u)/com.obsidian-reader
launchctl kickstart -k gui/$(id -u)/com.obsidian-reader
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.obsidian-reader.plist
```

A minimal LaunchAgent plist:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.obsidian-reader</string>
  <key>WorkingDirectory</key>
  <string>/path/to/obsidian-reader</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>/path/to/obsidian-reader/serve.sh</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/obsidian-reader-launchd.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/obsidian-reader-launchd.err</string>
</dict>
</plist>
```

## HTTP API

Main routes:

| Route | Purpose |
| --- | --- |
| `GET /` | Serves the SPA. |
| `GET /data/catalog.json` | Serves the generated article catalog with ETag/gzip support. |
| `GET /vault/*` | Proxies raw vault files after path-containment checks. |
| `POST /api/auth` | Password login. |
| `GET /api/check-auth` | Auth status. |
| `GET /api/config` | Current vault path and TTS setting. |
| `POST /api/config` | Update vault path and/or TTS setting. |
| `POST /api/password` | Change or disable the access password. |
| `POST /api/rescan` | Regenerate the catalog. |
| `GET /api/read-state` | Read/unread state with timestamps and tombstones. |
| `POST /api/read-state/add` | Mark one or more articles as read. |
| `POST /api/read-state/remove` | Mark one or more articles as unread. |
| `POST /api/note` | Add highlight/note data to a note file. |
| `GET /api/notes` | Load article notes. |
| `POST /api/tts` | Generate TTS audio and WebVTT subtitles when TTS is enabled. |
| `POST /api/transcribe` | Start MP3 transcription. |
| `POST /api/transcribe/status` | Poll transcription status. |
| `POST /api/align` | Align VTT cues to article paragraphs. |
| `GET /api/events` | Server-Sent Events for catalog updates. |

`/api/rescan` is POST-only because it has side effects.

## Scanner

`scan.py` scans the configured vault, extracts titles and metadata, and writes
`dist/data/catalog.json`.

Run it manually:

```bash
/usr/bin/python3 scan.py
```

The scanner preserves the top-level grouping used by the app:

- `Raw`
- `Wiki`

The generated catalog is ignored by git.

## TTS And MP3 Following

TTS is disabled unless `ttsEnabled` is explicitly `true`.

When enabled, the app can:

- Generate speech with Edge TTS.
- Cache generated audio in `/tmp/obsidian-reader-tts`.
- Highlight the current paragraph while audio plays.
- Start playback from selected text.
- Transcribe embedded MP3 files with `mlx-whisper`.
- Align VTT cues to article paragraphs using `align.py`.
- Use local semantic embeddings through `sentence-transformers` when available.
- Fall back to character/LCS alignment when semantic alignment is unavailable.

Alignment cache compatibility is controlled by `align-version.json`. The current
version is `14`.

## Notes, Highlights, And Editing

The frontend supports:

- Text highlights and notes.
- Jumping from note links back to the source highlight.
- Reading-mode checkbox toggles that write back to Markdown.
- A reading/editing mode toggle for direct Markdown edits.
- Quote-card sharing through `html2canvas`.

Notes are stored in Markdown note files next to the relevant content according to
the app's existing note format.

## Security Notes

- The backend serves local files from the configured vault only after resolving
  paths and checking directory containment.
- Password sessions use HMAC tokens backed by `.session-secret`.
- Changing the password rotates the secret and invalidates existing sessions.
- Failed auth attempts are rate-limited per client IP.
- Request bodies are capped to avoid unbounded memory use.
- Server-Sent Events are limited per IP.
- If serving outside localhost, put the app behind TLS termination and configure
  `trustedProxies`.
- Do not expose the plain HTTP port directly to the public internet.

## Reverse Proxy Deployment

Recommended public/mobile setup:

```text
browser / mobile app
  -> HTTPS reverse proxy
    -> http://127.0.0.1:8765 or http://LAN-IP:8765
      -> Obsidian Reader
```

Use Caddy, nginx, Synology reverse proxy, Cloudflare Tunnel, Tailscale, or another
TLS-capable proxy. When the proxy is on another LAN host, bind the app to a LAN
address or `0.0.0.0` and set `trustedProxies` to the proxy's LAN IP/CIDR.

## PWA Behavior

The service worker caches the app shell only. Dynamic vault content, API
responses, catalog data, and TTS cache files stay network-only so private content
does not get pinned in the browser cache unexpectedly.

## Development Checks

Useful syntax checks:

```bash
node --check server.js
node --check dist/sw.js
/usr/bin/python3 -m py_compile scan.py align.py
```

The frontend is a single HTML file with inline JavaScript. There is no package
manager or build command required for normal use.

## Git-Ignored Runtime Files

The following are local runtime artifacts:

- `config.json`
- `.session-secret`
- `read-articles.json`
- `dist/data/catalog.json`
- `node_modules/`
- logs and local debug scripts

## License

MIT
