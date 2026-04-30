# Obsidian Reader 📚

"某平台风格"知识库阅读器，直接映射 Obsidian Vault 的目录结构和内容，在浏览器中高效阅读。

![License](https://img.shields.io/badge/license-MIT-blue)

## 特性

- 📖 **零构建延迟** — Obsidian 里改文章，刷新页面即见最新
- 🔍 **全局搜索** — 侧边栏搜索框，键盘 `/` 快捷聚焦
- ✅ **已读/未读** — 手动标记，状态存 localStorage
- 🔒 **访问密码** — Cookie 认证保持一年，可通过网页修改密码
- 🌙 **暗色模式** — 一键切换，护眼阅读
- 📱 **响应式设计** — 三断点适配（桌面 / 平板 / 手机）
- 🎨 **书摘分享** — 选中文字生成精美书摘卡片，4 种风格可选，支持保存 PNG
- 🎧 **TTS 听书** — Edge TTS 高品质语音朗读，实时段落高亮跟读，支持倍速调节，点击高亮段落可暂停/继续
- 🎵 **媒体播放** — 支持音频（mp3/wav/ogg/m4a）和视频（mp4/webm）内嵌播放
- 🔗 **Wiki Link** — 支持 `[[链接]]` 站内跳转和 `![[文件]]` 嵌入
- 🔄 **热扫描** — 新增/删除文章后点击 🔄 即时更新目录，vault 变更自动检测
- ⚡ **极速加载** — localStorage 缓存 + ETag 304 + gzip 压缩，目录秒出

## 架构

```
浏览器 → Node.js server
              │
              ├── /              → SPA 前端
              ├── /data/*        → catalog.json（文章目录，ETag + gzip）
              ├── /vault/*       → Obsidian vault 文件代理
              ├── /tts-cache/*   → TTS 音频缓存
              ├── /api/auth      → POST 登录认证
              ├── /api/check-auth→ GET 检查认证状态
              ├── /api/config    → GET/POST vault 路径配置
              ├── /api/password  → POST 修改密码
              ├── /api/rescan    → GET 重新扫描 vault
              ├── /api/tts       → POST 生成 TTS 音频 + 字幕
              └── /api/events    → SSE 实时目录更新推送
```

- **前端**：单页应用，[marked.js](https://github.com/markedjs/marked) 浏览器端实时渲染 Markdown，[html2canvas](https://github.com/niklasvh/html2canvas) 生成书摘图片
- **后端**：Node.js 轻量 HTTP server，直接代理 vault 目录，gzip 压缩文本响应
- **扫描器**：`scan.py` 扫描 vault 生成 `catalog.json`（只含标题和路径，不含内容）
- **TTS**：[Edge TTS](https://github.com/rany2/edge-tts) 生成语音 + WebVTT 字幕，前端实时高亮跟读

## 快速开始

### 前置要求

- Node.js ≥ 18
- Python 3
- [edge-tts](https://github.com/rany2/edge-tts)（TTS 功能需要）：`pip install edge-tts`

### 安装

```bash
git clone https://github.com/Onpicex/obsidian-reader.git
cd obsidian-reader

# 创建配置
cp config.example.json config.json
# 编辑 config.json，设置你的 vault 路径和密码
```

### 配置

编辑 `config.json`：

```json
{
  "vault": "/path/to/your/obsidian/vault",
  "port": 8765,
  "bind": "0.0.0.0",
  "password": "your-secure-password"
}
```

| 字段 | 说明 |
|------|------|
| `vault` | Obsidian vault 绝对路径 |
| `port` | 服务端口（默认 8765） |
| `bind` | 绑定地址（`0.0.0.0` 允许局域网访问，`127.0.0.1` 仅本机） |
| `password` | 访问密码（留空 `""` 关闭密码功能） |

### 启动

```bash
./serve.sh
```

访问 `http://localhost:8765` 即可。

### macOS 开机自启（可选）

创建 `~/Library/LaunchAgents/com.obsidian-reader.plist`：

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
        <string>serve.sh</string>
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

```bash
# 加载
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.obsidian-reader.plist

# 重启
launchctl kickstart -k gui/$(id -u)/com.obsidian-reader

# 停止
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.obsidian-reader.plist
```

## TTS 听书

点击文章正文工具栏的 🎧 按钮开启听书模式：

- **Edge TTS** 高品质中文语音（zh-CN-XiaoxiaoNeural）
- **实时段落高亮** — 语音读到哪里，对应段落自动高亮并滚动跟随
- **倍速控制** — 0.6x / 0.8x / 1.0x / 1.2x / 1.5x / 2.0x 循环切换
- **播放/暂停/停止** — 完整播放控制，也可点击高亮段落切换暂停/继续
- **智能缓存** — 同一篇文章只生成一次音频，后续播放直接使用缓存

技术实现：服务端调用 edge-tts 生成 MP3 + WebVTT 字幕文件，前端通过 `<audio>` 播放并解析 VTT 时间戳，用文本对齐算法精确映射到 DOM 段落。

## 书摘分享

选中文章正文中的文字 → 弹出「📋 分享书摘」浮条 → 生成精美书摘卡片：

| 风格 | 特点 |
|------|------|
| ⚪ 简约白 | 白底 + 金色左边框 + 经典引号装饰 |
| 📜 文艺纸 | 羊皮纸渐变 + 居中花饰 + 斜体排版 |
| 🌙 暗夜 | 深色渐变 + 紫色左边框 + 冷调配色 |
| 🌿 清新绿 | 浅绿渐变 + 绿色边框 + 自然感 |

选中文字后浮条提供两个操作：
- 「🎧 从此处听」— 直接从选中位置开始 TTS 播放
- 「📋 分享书摘」— 生成精美书摘卡片

支持「📋 复制文字」（带出处）和「💾 保存图片」（html2canvas 3x 高清 PNG）。

## 性能优化

- **gzip 压缩** — 文本响应（JSON/HTML/JS/CSS/VTT 等）自动 gzip，catalog.json 从 364KB 压缩到 ~39KB
- **ETag 304** — catalog.json 基于 mtime+size 生成 ETag，未变更时返回 304 零传输
- **localStorage 缓存** — 目录数据缓存到浏览器本地，刷新页面瞬间渲染，后台静默检查更新
- **SSE 实时推送** — vault 文件变更时通过 Server-Sent Events 自动推送目录更新，无需手动刷新

## 文件结构

```
obsidian-reader/
├── config.example.json  — 配置模板
├── config.json          — 配置（.gitignore 忽略）
├── scan.py              — vault 扫描器（Python）
├── server.js            — HTTP 服务器（Node.js）
├── serve.sh             — 启动脚本：scan → server
└── dist/
    ├── index.html       — SPA 前端
    └── data/
        └── catalog.json — 文章目录（自动生成，.gitignore 忽略）
```

## 技术细节

- 认证：随机 session token，cookie 有效期一年
- `catalog.json` 只存标题 + 路径（不含内容），前端按需 fetch `/vault/*` 拿原始 Markdown
- 前端用 marked.js 实时渲染，零预编译
- catalog.json 使用 ETag + `no-cache` 策略（浏览器先验证再决定是否下载），前端额外用 localStorage 做即时缓存
- Obsidian embed 语法（`![[文件]]`）支持图片、音频、视频三种媒体类型
- TTS 音频缓存在 `/tmp/obsidian-reader-tts/`，基于文章内容哈希命名，缓存 7 天自动清理
- TTS 音频服务支持 HTTP Range 请求（206 Partial Content），确保浏览器 seek 到任意位置
- fs.watch 递归监听 vault 目录变更，2 秒防抖后自动 rescan + SSE 推送

## License

MIT
