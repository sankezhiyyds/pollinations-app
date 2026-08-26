# Pollinations Studio

BYOK（Bring Your Own Key）纯前端 AI 生成工具，基于 [Pollinations.ai](https://pollinations.ai) API，支持图片、文本对话、语音合成、视频生成。

## 功能

- **图片生成** — 多种模型（Flux、Turbo、Seedream 等），支持文生图、图生图
- **文本对话** — 多模型切换，支持思维链推理
- **语音合成** — 多种音色，支持情绪/风格指令
- **视频生成** — 多模型、多分辨率
- **工具箱** — 图片格式转换，以及视频转 WebM、MP4、动态 WebP 和 GIF
- **历史记录** — 本地持久化
- **多语言** — 中文、英文、日文
- **深浅色主题** — 自动或手动切换

## 使用

1. 打开 `index.html`（双击或用本地服务器）
2. 首页直接展示功能面板，点击右上角「登录」输入 API Key
3. 或选择「匿名试用」快速体验（有速率限制）

无需安装，无需构建，纯静态 HTML/JS。

## API Key

| 类型 | 前缀 | 说明 |
|------|------|------|
| Secret Key | `sk_` | 服务端完整权限 |
| App Key | `pk_` | 客户端限权 |

获取：[https://enter.pollinations.ai/keys](https://enter.pollinations.ai/keys)

**安全性：** Key 仅存浏览器 localStorage，不上传任何第三方。

## 商店合规

本应用遵循 [Pollinations Apps 提交规范](https://github.com/pollinations/pollinations/blob/main/apps/README.md)：

- ✅ Pollinations 作为唯一后端
- ✅ 开源（MIT License）
- ✅ 明确归属 "Powered by Pollinations"
- ✅ BYOK 模式，不代收 Key

## 技术

- 纯原生 HTML/CSS/JS，无框架、无打包器
- 视频转码使用浏览器原生 MediaRecorder；动态 GIF 使用本地开源 gif.js 编码器
- 动态 WebP 在浏览器本地逐帧编码并组装动画容器
- 可直接部署到 GitHub Pages 等静态托管服务

## 许可证

MIT License
