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
- 🎵 **媒体播放** — 支持音频（mp3/wav/ogg/m4a）和视频（mp4/webm）内嵌播放
- 🔗 **Wiki Link** — 支持 `[[链接]]` 站内跳转和 `![[文件]]` 嵌入
- 🔄 **热扫描** — 新增/删除文章后点击 🔄 即时更新目录

## 架构

```
浏览器 → Node.js server
              │
              ├── /              → SPA 前端
              ├── /data/*        → catalog.json（文章目录）
              ├── /vault/*       → Obsidian vault 文件代理
              ├── /api/auth      → POST 登录认证
              ├── /api/check-auth→ GET 检查认证状态
              ├── /api/config    → GET/POST vault 路径配置
              ├── /api/password  → POST 修改密码
              └── /api/rescan    → GET 重新扫描 vault
```

- **前端**：单页应用，[marked.js](https://github.com/markedjs/marked) 浏览器端实时渲染 Markdown，[html2canvas](https://github.com/niklasvh/html2canvas) 生成书摘图片
- **后端**：Node.js 轻量 HTTP server，直接代理 vault 目录
- **扫描器**：`scan.py` 扫描 vault 生成 `catalog.json`（只含标题和路径，不含内容）

## 快速开始

### 前置要求

- Node.js ≥ 18
- Python 3

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

## 书摘分享

选中文章正文中的文字 → 弹出「📋 分享书摘」浮条 → 生成精美书摘卡片：

| 风格 | 特点 |
|------|------|
| ⚪ 简约白 | 白底 + 金色左边框 + 经典引号装饰 |
| 📜 文艺纸 | 羊皮纸渐变 + 居中花饰 + 斜体排版 |
| 🌙 暗夜 | 深色渐变 + 紫色左边框 + 冷调配色 |
| 🌿 清新绿 | 浅绿渐变 + 绿色边框 + 自然感 |

支持「📋 复制文字」（带出处）和「💾 保存图片」（html2canvas 3x 高清 PNG）。

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
- 数据请求全部 `cache: 'no-store'` + 服务端 `no-store, no-cache, must-revalidate`，确保实时更新
- Obsidian embed 语法（`![[文件]]`）支持图片、音频、视频三种媒体类型

## License

MIT
