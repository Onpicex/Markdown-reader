# Obsidian Reader

[English README](README.md)

一个轻量级的 Obsidian Vault 网页阅读器。它会扫描 Markdown 文件生成目录，通过一个小型 Node.js 后端代理原始 Vault 文件，并在浏览器里的单页应用中渲染阅读。

本仓库默认 README 使用英文。运行时密钥和机器相关配置应放在 `config.json`，该文件已被 git 忽略。

## 功能

- 在浏览器侧边栏中映射 Obsidian Vault 的目录结构。
- 使用 `marked.js` 按需渲染 Markdown。
- 支持 Obsidian wiki link，例如 `[[Page]]`，以及 `![[file.mp3]]`、`![[image.png]]`、`![[video.mp4]]` 等嵌入媒体。
- 通过侧边栏勾选标记追踪已读/未读，并持久化保存。
- 使用 per-id last-write-wins 时间戳和 tombstone 同步多设备已读状态，避免旧客户端把已取消的已读状态重新恢复。
- 侧边栏文章搜索。
- 字体大小控制、浅色/深色/护眼主题，以及移动端布局支持。
- 访问密码保护，一年有效期的 HTTP-only cookie session。
- 已认证用户可在 UI 中更新 Vault 路径和 TTS 开关。
- 支持手动重新扫描和 Vault 文件变化自动重新扫描。
- 提供 PWA metadata 和 service worker，可安装应用外壳。
- 默认展开一级分类，更深层级默认收起。
- 可选 TTS 和 MP3 字幕跟读功能。

## 当前本地部署

以下是这台机器上的当前部署快照，不是所有克隆都必须使用的默认值。

| 项目 | 值 |
| --- | --- |
| 项目路径 | `/Users/lhx/.openclaw/workspace/obsidian-reader` |
| Vault 路径 | `/Users/lhx/Library/Mobile Documents/iCloud~md~obsidian/Documents/Openclaw` |
| LaunchAgent label | `com.obsidian-reader` |
| 端口 | `8765` |
| 绑定地址 | `0.0.0.0` |
| 局域网地址 | `http://192.168.x.x:8765` |
| 对齐缓存版本 | `14` |
| TTS | 在 `config.json` 中关闭 |

## 仓库结构

```text
obsidian-reader/
├── server.js                 # Node.js HTTP 后端和 Vault 代理
├── scan.py                   # Markdown Vault 扫描器，生成 catalog.json
├── align.py                  # MP3/VTT 到文章段落的对齐脚本
├── align-version.json        # 共享的对齐缓存版本
├── serve.sh                  # 启动脚本：先扫描，再启动服务
├── config.example.json       # 安全配置模板
├── config.json               # 本地配置，git 忽略
├── read-articles.json        # 已读状态存储，git 忽略
└── dist/
    ├── index.html            # 单页前端应用
    ├── sw.js                 # PWA service worker
    ├── manifest.webmanifest
    ├── data/catalog.json     # 自动生成目录，git 忽略
    └── vendor/
        ├── marked.min.js
        ├── purify.min.js
        └── html2canvas.min.js
```

## 运行要求

必需：

- Node.js 18 或更新版本
- Python 3

可选：

- `edge-tts`，仅启用 TTS 时需要。
- `mlx-whisper`，仅在 Apple Silicon 上进行本地 MP3 转写时需要。
- `sentence-transformers`，仅需要更好的语义对齐质量时使用。

只在使用对应功能时安装这些可选 Python 工具：

```bash
pip install edge-tts
pip install mlx-whisper
pip install sentence-transformers
```

前端依赖已经 vendored 在 `dist/vendor/` 中，不需要前端构建步骤。

## 配置

从模板创建本地配置：

```bash
cp config.example.json config.json
```

示例：

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

字段：

| 字段 | 含义 |
| --- | --- |
| `vault` | Obsidian Vault 的绝对路径。 |
| `port` | HTTP 端口。配置缺失时默认 `8765`。 |
| `bind` | 绑定地址。`127.0.0.1` 仅本机访问；`0.0.0.0` 或局域网 IP 可用于局域网/反向代理回源。缺失配置时安全回退到 `127.0.0.1`。 |
| `trustedProxies` | 可选的反向代理 IP/CIDR 白名单。通过 nginx、Caddy、群晖反代、Cloudflare Tunnel 等部署时使用。 |
| `password` | 浏览器访问密码。空字符串会关闭密码保护。没有旧密码时，初次设置密码只允许从 direct loopback 操作。 |
| `ttsEnabled` | 只有显式设为 `true` 时才显示 TTS 控件。默认关闭。 |
| `mlxWhisperBin` | 可选的 `mlx_whisper` 可执行文件路径。 |

不要提交 `config.json`。它可能包含 Vault 路径、密码、私有局域网信息或部署相关的代理配置。

## 本地启动

运行：

```bash
./serve.sh
```

`serve.sh` 会先执行一次扫描，然后启动 `server.js`。

打开：

```text
http://localhost:8765
```

如果你的配置使用了其他端口，请使用对应端口。

## macOS LaunchAgent

当前本地部署使用 LaunchAgent：

```text
~/Library/LaunchAgents/com.obsidian-reader.plist
```

常用命令：

```bash
launchctl print gui/$(id -u)/com.obsidian-reader
launchctl kickstart -k gui/$(id -u)/com.obsidian-reader
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.obsidian-reader.plist
```

最小 LaunchAgent plist：

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

主要路由：

| 路由 | 用途 |
| --- | --- |
| `GET /` | 提供 SPA。 |
| `GET /data/catalog.json` | 提供生成的文章目录，支持 ETag/gzip。 |
| `GET /vault/*` | 在路径边界检查后代理原始 Vault 文件。 |
| `POST /api/auth` | 密码登录。 |
| `GET /api/check-auth` | 认证状态。 |
| `GET /api/config` | 当前 Vault 路径和 TTS 设置。 |
| `POST /api/config` | 更新 Vault 路径和/或 TTS 设置。 |
| `POST /api/password` | 修改或关闭访问密码。 |
| `POST /api/rescan` | 重新生成目录。 |
| `GET /api/read-state` | 带时间戳和 tombstone 的已读/未读状态。 |
| `POST /api/read-state/add` | 将一篇或多篇文章标记为已读。 |
| `POST /api/read-state/remove` | 将一篇或多篇文章标记为未读。 |
| `POST /api/note` | 添加高亮/笔记数据到笔记文件。 |
| `GET /api/notes` | 加载文章笔记。 |
| `POST /api/tts` | 在 TTS 启用时生成 TTS 音频和 WebVTT 字幕。 |
| `POST /api/transcribe` | 启动 MP3 转写。 |
| `POST /api/transcribe/status` | 查询转写状态。 |
| `POST /api/align` | 将 VTT cue 对齐到文章段落。 |
| `GET /api/events` | 用于目录更新的 Server-Sent Events。 |

`/api/rescan` 只支持 POST，因为它有副作用。

## 扫描器

`scan.py` 会扫描配置的 Vault，提取标题和元数据，并写入 `dist/data/catalog.json`。

手动运行：

```bash
/usr/bin/python3 scan.py
```

扫描器保留应用使用的顶层分组：

- `Raw`
- `Wiki`

生成的目录文件会被 git 忽略。

## TTS 和 MP3 跟读

除非 `ttsEnabled` 显式设为 `true`，否则 TTS 默认关闭。

启用后应用可以：

- 使用 Edge TTS 生成语音。
- 将生成的音频缓存到 `/tmp/obsidian-reader-tts`。
- 播放时高亮当前段落。
- 从选中文本处开始播放。
- 使用 `mlx-whisper` 转写嵌入的 MP3 文件。
- 使用 `align.py` 将 VTT cue 对齐到文章段落。
- 可用时通过 `sentence-transformers` 使用本地语义 embedding。
- 语义对齐不可用时回退到字符/LCS 对齐。

对齐缓存兼容性由 `align-version.json` 控制。当前版本是 `14`。

## 笔记、高亮和编辑

前端支持：

- 文本高亮和笔记。
- 从笔记链接跳回原文高亮位置。
- 阅读模式下勾选 checkbox 并写回 Markdown。
- 阅读/编辑模式切换，直接编辑 Markdown。
- 使用 `html2canvas` 生成书摘分享卡片。

笔记会按照应用既有格式存储在相关内容旁边的 Markdown 笔记文件中。

## 安全说明

- 后端只在解析路径并通过目录边界检查后，才会提供配置 Vault 内的本地文件。
- 密码 session 使用基于 `.session-secret` 的 HMAC token。
- 修改密码会轮换 secret，使现有 session 失效。
- 登录失败会按客户端 IP 限速。
- 请求体有大小限制，避免无边界内存占用。
- Server-Sent Events 按 IP 限制连接数。
- 如果不是只在 localhost 使用，请把应用放在 TLS 终止之后，并配置 `trustedProxies`。
- 不要把明文 HTTP 端口直接暴露到公网。

## 反向代理部署

推荐的公网/移动端部署方式：

```text
browser / mobile app
  -> HTTPS reverse proxy
    -> http://127.0.0.1:8765 or http://LAN-IP:8765
      -> Obsidian Reader
```

可以使用 Caddy、nginx、群晖反向代理、Cloudflare Tunnel、Tailscale 或其他支持 TLS 的代理。代理在另一台局域网主机上时，将应用绑定到局域网地址或 `0.0.0.0`，并将 `trustedProxies` 设置为该代理的局域网 IP/CIDR。

## PWA 行为

Service worker 只缓存应用外壳。动态 Vault 内容、API 响应、目录数据和 TTS 缓存文件都保持 network-only，避免私有内容被意外固定在浏览器缓存里。

## 开发检查

常用语法检查：

```bash
node --check server.js
node --check dist/sw.js
/usr/bin/python3 -m py_compile scan.py align.py
```

前端是一个包含内联 JavaScript 的单 HTML 文件。正常使用不需要 package manager 或构建命令。

## Git 忽略的运行时文件

以下是本地运行时产物：

- `config.json`
- `.session-secret`
- `read-articles.json`
- `dist/data/catalog.json`
- `node_modules/`
- 日志和本地调试脚本

## License

MIT
