# Markdown Reader 📚

Markdown 知识库阅读器,直接映射 Obsidian Vault 的目录结构和内容,在浏览器中高效阅读。

![License](https://img.shields.io/badge/license-MIT-blue)

## 特性

- 📖 **零构建延迟** - Obsidian 里改文章,刷新页面即见最新
- 🔍 **全局搜索** - 侧边栏搜索框,键盘 `/` 快捷聚焦
- ✅ **已读/未读** - 手动标记,状态存 localStorage
- 🔒 **访问密码** - Cookie 认证保持一年,可通过网页修改密码
- 🎨 **三主题切换** - 浅色/暗色/护眼三种阅读主题
- 📱 **响应式设计** - 三断点适配(桌面 / 平板 / 手机)
- 🤖 **Android WebView 客户端** - 可用独立原生 Android WebView 壳加载现有服务 URL,默认 `http://your-host.example:8765`,Web 版保持不变
- 🎨 **书摘分享** - 选中文字生成精美书摘卡片,4 种风格可选,支持保存 PNG
- 🎧 **TTS 听书** - Edge TTS 高品质语音朗读,实时段落高亮跟读,支持倍速调节,点击高亮段落可暂停/继续
- 🎵 **MP3 字幕跟读** - 内嵌 MP3 音频逐段高亮跟读,智能模糊匹配算法对齐转录与原文,自动检测并跳过音频开头介绍
- 🧠 **语义 Embedding 对齐** - 当口语讲稿与书面文章用词差异大时,自动启用 AI 语义匹配(bge-small-zh),匹配率从 33% 提升到 100%,完全本地运行不花钱
- 🗣️ **对话感知对齐** - 连续短引号对话自动检测,预合并 + 字符级匹配 + 按文字长度比例分配时间,Whisper 幻觉丢失的对话段也能获得合理跟读时间
- 🎯 **从选中处听** - 选中文字后一键跳转到对应音频位置播放(支持 TTS 和 MP3)
- 🎵 **媒体播放** - 支持音频(mp3/wav/ogg/m4a)和视频(mp4/webm)内嵌播放
- 🔗 **Wiki Link** - 支持 `[[链接]]` 站内跳转和 `![[文件]]` 嵌入
- 📝 **高亮标注与笔记** - 选中文字可高亮或添加笔记,存储在同目录笔记.md
- 🔗 **笔记链接跳转** - 从笔记页面点击跳转到原文对应高亮位置
- ⬅️➡️ **上下篇导航** - 文章底部快速切换前/后一篇
- 📂 **递归目录树** - 侧边栏多级目录展开/折叠,记忆展开状态
- ✏️ **编辑模式** - 一键切换阅读/编辑模式,直接修改 Markdown 源文件
- ☑️ **可点击 Checkbox** - 阅读模式下直接勾选/取消 Checkbox,自动保存到源文件
- ⚙️ **TTS 开关** - 设置中一键开关 TTS 听书功能,即时生效并持久化
- 🍞 **面包屑导航** - 可点击的层级路径导航
- 🔄 **热扫描** - 新增/删除文章后点击 🔄 即时更新目录,vault 变更自动检测
- ⚡ **极速加载** - localStorage 缓存 + ETag 304 + gzip 压缩,目录秒出

## 依赖

### 必需

| 依赖 | 说明 |
|------|------|
| **Node.js** ≥ 18 | HTTP 服务器运行时 |
| **Python 3** | Vault 扫描器 (`scan.py`) |
| **edge-tts** | Microsoft Edge TTS 引擎,生成 MP3 + WebVTT 字幕。免费,无需 API Key,本地调用微软 Edge 服务 |

```bash
pip install edge-tts
```

### 可选(MP3 字幕跟读功能)

| 依赖 | 说明 |
|------|------|
| **mlx-whisper** | Apple Silicon 本地语音转文字模型,用于将内嵌 MP3 音频转录为 VTT 字幕。仅"字幕跟读"功能需要,需 Apple Silicon Mac |
| **sentence-transformers** | 语义 Embedding 对齐模型,口语讲稿与书面文章的智能匹配。可选,无此依赖时自动降级为 LCS 字符匹配 |

```bash
pip install mlx-whisper
pip install sentence-transformers  # 可选,语义对齐
```

- mlx-whisper 模型:`mlx-community/whisper-large-v3-turbo`(首次使用自动下载,约 1.5GB)
- embedding 模型:`BAAI/bge-small-zh-v1.5`(首次使用自动下载,约 90MB)
- 性能:12 分钟音频 ≈ 1.5 分钟转录(Apple Silicon)
- 注意:mlx_whisper CLI 路径优先读 `config.json` 的 `mlxWhisperBin`，否则读环境变量 `MLX_WHISPER_BIN`，最后回退到 `PATH` 中的 `mlx_whisper`

### 前端(已内置,无需安装)

| 库 | 用途 |
|------|------|
| **marked.js** | Markdown 渲染 |
| **html2canvas** | 书摘分享卡片/截图生成 |

## 功能成本分类

### 🆓 零成本功能(本地运行,不消耗 Token)

| 功能 | 技术实现 |
|------|----------|
| Markdown 渲染阅读 | marked.js (浏览器端) |
| TTS 听书 + 段落高亮 | edge-tts (免费微软 Edge 服务) |
| MP3 字幕跟读 | mlx-whisper (本地 Apple Silicon 模型) |
| 语义 Embedding 对齐 | sentence-transformers + bge-small-zh (本地 CPU) |
| MP3 从选中处听 | 前端 seek + HTTP Range |
| 书摘分享卡片 | html2canvas (浏览器端) |
| 高亮标注 + 笔记 | 本地文件存储 (笔记.md) |
| 全局搜索 | 本地 catalog.json |
| 多主题切换 | CSS + localStorage |
| 目录树浏览 | 本地 catalog 数据 |
| 编辑/阅读模式 | 直接读写 vault 文件 |
| Wiki Link 跳转 | 前端路由 |
| 热扫描 + SSE 推送 | fs.watch + Python scanner |
| 密码认证 | Cookie session |

### 💰 消耗 AI Token 的功能

| 功能 | 说明 |
|------|------|
| 无 | 本项目完全不依赖任何 AI API,所有功能均在本地运行 |

> **Note:** 本项目 100% 自包含,无需 OpenAI/Anthropic/Google API Key。唯一的网络依赖是 edge-tts,使用微软免费的 Edge 服务。

## 架构

```
浏览器 → Node.js server
              │
              ├── /              → SPA 前端
              ├── /data/*        → catalog.json(文章目录,ETag + gzip)
              ├── /vault/*       → Obsidian vault 文件代理
              ├── /tts-cache/*   → TTS 音频缓存
              ├── /api/auth      → POST 登录认证
              ├── /api/check-auth→ GET 检查认证状态
              ├── /api/config    → GET/POST vault 路径配置
              ├── /api/password  → POST 修改密码
              ├── /api/rescan    → GET 重新扫描 vault
              ├── /api/tts       → POST 生成 TTS 音频 + 字幕
              ├── /api/note      → POST 添加笔记/高亮
              ├── /api/note/delete → POST 删除笔记
              ├── /api/note/edit → POST 编辑笔记
              ├── /api/notes     → GET 获取文章笔记
              ├── /api/transcribe → POST 发起音频转录
              ├── /api/transcribe/status → POST 查询转录进度
              ├── /api/align     → POST 语义 Embedding 对齐(自动缓存)
              └── /api/events    → SSE 实时目录更新推送(需鉴权,单 IP ≤5 连接,30s 心跳)
```

- **前端**:单页应用,[marked.js](https://github.com/markedjs/marked) 浏览器端实时渲染 Markdown,[html2canvas](https://github.com/niklasvh/html2canvas) 生成书摘图片
- **后端**:Node.js 轻量 HTTP server,直接代理 vault 目录,gzip 压缩文本响应
- **扫描器**:`scan.py` 扫描 vault 生成 `catalog.json`(只含标题和路径,不含内容)
- **TTS**:[Edge TTS](https://github.com/rany2/edge-tts) 生成语音 + WebVTT 字幕,前端实时高亮跟读
- **转录**:mlx-whisper 本地转录 MP3 → VTT 字幕,前端模糊匹配对齐原文段落
- **语义对齐**:`align.py` 用 [bge-small-zh-v1.5](https://huggingface.co/BAAI/bge-small-zh-v1.5) embedding 模型计算 VTT 块与文章段落的余弦相似度,单调递增贪心分配 + 插值填补空段,结果缓存为 `.align.json`。对话运检测自动将连续短句合并为虚拟段,未映射段落按文字长度比例分配时间,缓存自动根据文章/VTT mtime 失效重生

## 快速开始

### 前置要求

- Node.js ≥ 18
- Python 3
- [edge-tts](https://github.com/rany2/edge-tts)(TTS 功能需要):`pip install edge-tts`
- [mlx-whisper](https://github.com/ml-explore/mlx-examples)(MP3 字幕跟读,可选):`pip install mlx-whisper`

### 安装

```bash
git clone https://github.com/Onpicex/Markdown-reader.git
cd Markdown-reader

# 创建配置
cp config.example.json config.json
# 编辑 config.json,设置你的 vault 路径和密码
```

### 配置

编辑 `config.json`:

```json
{
  "vault": "/path/to/your/obsidian/vault",
  "port": 8765,
  "bind": "0.0.0.0",
  "password": "your-secure-password",
  "ttsEnabled": true
}
```

| 字段 | 说明 |
|------|------|
| `vault` | Obsidian vault 绝对路径 |
| `port` | 服务端口(默认 8765) |
| `bind` | 绑定地址(`0.0.0.0` 允许局域网访问,`127.0.0.1` 仅本机) |
| `password` | 访问密码(留空 `""` 关闭密码功能;**首次设置必须从 127.0.0.1 操作**) |
| `ttsEnabled` | TTS 听书功能开关(默认 `false`,设为 `true` 显示所有 TTS 相关按钮) |
| `mlxWhisperBin` | (可选)mlx_whisper 可执行文件路径,默认从 `PATH` 解析 |

> 安全说明:`/api/auth` 同 IP 60s 内 ≤10 次失败;成功认证签发 HMAC token(基于 `.session-secret` 文件,文件丢失会强制所有人重登);改密码会轮换 secret,所有旧 token 失效。

### 当前部署约定

- 本地项目目录:`/Users/lhx/.openclaw/workspace/obsidian-reader`
- macOS LaunchAgent:`~/Library/LaunchAgents/com.obsidian-reader.plist`
- 服务端口:`8765`
- 公网/移动端默认访问地址:`http://your-host.example:8765`
- Android 客户端策略:使用独立原生 Android WebView wrapper 加载上面的服务 URL,不改动现有 Web 前端/后端。因为当前是 HTTP 地址,Android 端需要为 `your-host.example` 配置 cleartext traffic。

### 启动

```bash
./serve.sh
```

访问 `http://localhost:8765` 即可。

### macOS 开机自启(可选)

创建 `~/Library/LaunchAgents/com.obsidian-reader.plist`:

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

## Android 客户端

知识库阅读器的 Android 端推荐做成**独立原生 WebView 壳**:

```text
Android App
  └── WebView
        └── http://your-host.example:8765
              └── 现有 Markdown Reader Web 服务
```

设计原则:

- Web 版保持不变:继续由 `server.js` + `dist/index.html` 提供浏览器端体验。
- Android 端只负责 WebView 容器能力:网络权限、Cookie、DOM Storage、下载、返回键、错误页、进度条。
- 默认服务 URL:`http://your-host.example:8765`。
- 因为默认 URL 是 HTTP,Android Manifest 需要 `android:usesCleartextTraffic="true"`,并建议在 `network_security_config.xml` 中只对白名单域名 `your-host.example` 放行明文流量。
- 后续如切到 HTTPS,应移除 cleartext 配置。

最小 WebView 配置要点:

- `INTERNET` / `ACCESS_NETWORK_STATE` 权限
- `setJavaScriptEnabled(true)`
- `setDomStorageEnabled(true)`
- `CookieManager.setAcceptCookie(true)`
- 同源链接留在 WebView,外部链接交给系统浏览器
- Android 返回键优先 `webView.goBack()`
- `DownloadListener` 转交系统 DownloadManager,并携带 Cookie header

## TTS 听书

点击文章正文工具栏的 🎧 按钮开启听书模式:

- **Edge TTS** 高品质中文语音(zh-CN-XiaoxiaoNeural)
- **实时段落高亮** - 语音读到哪里,对应段落自动高亮并滚动跟随
- **倍速控制** - 0.6x / 0.8x / 1.0x / 1.2x / 1.5x / 2.0x 循环切换
- **播放/暂停/停止** - 完整播放控制,也可点击高亮段落切换暂停/继续
- **智能缓存** - 同一篇文章只生成一次音频,后续播放直接使用缓存
- **一键从选中处听** - 选中文字 → 点击「🎵 从此处听(MP3)」自动开启跟读并跳到对应位置,无需预先手动激活

技术实现:服务端调用 edge-tts 生成 MP3 + WebVTT 字幕文件,前端通过 `<audio>` 播放并解析 VTT 时间戳,用文本对齐算法精确映射到 DOM 段落。

## 语义 Embedding 对齐

MP3 字幕跟读时,当音频是口语讲稿而文章是书面版时(两者用词差异大),传统的字符匹配算法(LCS)只能达到 ~33% 的匹配率。

本项目集成了 [BAAI/bge-small-zh-v1.5](https://huggingface.co/BAAI/bge-small-zh-v1.5) 语义 embedding 模型,将匹配率提升到 **100%**:

| | LCS 字符匹配 | Embedding 语义匹配 |
|---|---|---|
| 口语 vs 书面 | ~33% | **100%** |
| 段落命中 | 26/50 | **39/50** |
| 首次加载 | 即时 | ~8s(模型加载) |
| 后续加载 | 即时 | 即时(缓存) |

### 工作原理

1. 将 VTT 字幕合并为 ~40 字的 chunk
2. 检测连续短段落(≤30字×≥3段,如引号对话),预合并为虚拟段提高 embedding 质量
3. 用 embedding 模型编码所有 chunk 和(虚拟)段落
4. 计算余弦相似度矩阵,贪心单调分配
5. 对话运内部用字符级相似度拆回各小段
6. 未映射段落按文字长度比例分配时间,当已映射段时间过多时自动再分配
7. 结果缓存为 `.align.json`,服务端检测文章/VTT mtime 自动失效重生

### 降级策略

如果未安装 `sentence-transformers` 或 embedding 服务不可用,前端自动降级为 LCS 字符匹配算法,不影响基本功能。

## 书摘分享

选中文章正文中的文字 → 弹出「📋 分享书摘」浮条 → 生成精美书摘卡片:

| 风格 | 特点 |
|------|------|
| 🖤 水墨 | 纯白底 + 深色文字,最简洁 |
| ☕ 暖纸 | 暖色纸张底 + 暖调文字 |
| 🌙 暗夜 | 深色底 + 浅色文字 |
| 🌿 青白 | 淡青底 + 自然配色 |

选中文字后浮条提供两个操作:
- 「🎧 从此处听」- 直接从选中位置开始 TTS 播放
- 「📋 分享书摘」- 生成精美书摘卡片

支持「📋 复制文字」(带出处)和「💾 保存图片」(html2canvas 3x 高清 PNG)。

## 技术细节

- 认证:随机 session token,cookie 有效期一年
- `catalog.json` 只存标题 + 路径(不含内容),前端按需 fetch `/vault/*` 拿原始 Markdown
- 前端用 marked.js 实时渲染,零预编译
- catalog.json 使用 ETag + `no-cache` 策略(浏览器先验证再决定是否下载),前端额外用 localStorage 做即时缓存
- Obsidian embed 语法(`![[文件]]`)支持图片、音频、视频三种媒体类型
- TTS 音频缓存在 `/tmp/obsidian-reader-tts/`,基于文章内容哈希命名,缓存 7 天自动清理
- TTS 音频服务支持 HTTP Range 请求(206 Partial Content),确保浏览器 seek 到任意位置
- Vault 音频/视频文件支持 HTTP Range 请求(206 Partial Content),使用 `fs.createReadStream` 流式传输
- InlineAudio 字幕跟读优先使用语义 Embedding 对齐(bge-small-zh-v1.5),失败时自动降级为 LCS 字符匹配算法(charSim + LCS 滑动窗口)
- Embedding 对齐将 VTT cue 合并为 ~40 字 chunk，与文章段落计算余弦相似度，贪心单调分配，口语 vs 书面匹配率从 33% 提升到 100%。对话运检测自动将连续短句合并为虚拟段做 embedding，再用 char_similarity 拆回；未映射段落按文字长度比例分配时间，当已映射段时间过多时自动再分配给相邻未映射段
- LCS 降级算法采用匹配中心定位,miss 时时间比例 cursor 推进防止级联失败,连续 2 次失败自动重锚
- VTT 解析阶段自动清理零时长 cue、重复文本 cue、Whisper 幻觉
- 段落时间范围采用比例插值填补 + 连续化处理(无间隙无重叠),二分查找 + 正向锁定防止回跳
- 笔记系统支持两种存储格式:`## [[title]]` 分节和 `---` 分隔块,向后兼容
- 主题存储在 localStorage,三种主题:light / dark / eye-care
- fs.watch 递归监听 vault 目录变更,2 秒防抖后自动 rescan + SSE 推送

## 性能优化

- **gzip 压缩** - 文本响应(JSON/HTML/JS/CSS/VTT 等)自动 gzip,catalog.json 从 364KB 压缩到 ~39KB
- **ETag 304** - catalog.json 基于 mtime+size 生成 ETag,未变更时返回 304 零传输
- **localStorage 缓存** - 目录数据缓存到浏览器本地,刷新页面瞬间渲染,后台静默检查更新
- **SSE 实时推送** - vault 文件变更时通过 Server-Sent Events 自动推送目录更新,无需手动刷新

## 文件结构

```
Markdown-reader/
├── config.example.json  - 配置模板
├── config.json          - 配置(.gitignore 忽略)
├── scan.py              - vault 扫描器(Python)
├── align.py             - 语义 Embedding 对齐脚本(Python)
├── server.js            - HTTP 服务器(Node.js)
├── serve.sh             - 启动脚本:scan → server
└── dist/
    ├── index.html       - SPA 前端
    └── data/
        └── catalog.json - 文章目录(自动生成,.gitignore 忽略)
```

Android wrapper 建议放在独立同级目录,例如:

```
workspace/
├── obsidian-reader/          - Web 服务,本仓库
└── obsidian-reader-android/  - 原生 Android WebView 壳,加载 http://your-host.example:8765
```

## License

MIT
