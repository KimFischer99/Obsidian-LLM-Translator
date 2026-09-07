<p align="right">
  <a href="README.md"><img src="https://img.shields.io/badge/EN-English-blue" alt="English"></a>
  <a href="README_CN.md"><img src="https://img.shields.io/badge/CN-简体中文-green" alt="简体中文"></a>
</p>

# LLM Translator

<p align="center">
  <img src="https://img.shields.io/badge/platform-Obsidian%20Desktop-purple" alt="Platform">
  <img src="https://img.shields.io/github/v/release/KimFischer99/Obsidian-LLM-Translator" alt="Version">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="License">
  <img src="https://img.shields.io/badge/language-Chinese%20%7C%20English%20%7C%20Turkish-green" alt="Languages">
</p>

<p align="center">
  <a href="#功能特性">功能特性</a> •
  <a href="#快速开始">快速开始</a> •
  <a href="#推荐配置">推荐配置</a> •
  <a href="#使用指南">使用指南</a> •
  <a href="#其他翻译服务">其他翻译服务</a> •
  <a href="#windows-注意事项">Windows 注意事项</a> •
  <a href="#常见问题">常见问题</a> •
  <a href="#开发">开发</a>
</p>

<p align="center">一款基于本地大模型驱动的 Obsidian 划词翻译插件，支持 PDF 和 Markdown 文件的实时翻译。</p>

<p align="center">
  <img src="assets/screenshot.webp" alt="LLM Translator Screenshot" width="720" style="border-radius: 8px;">
</p>

---

## 功能特性

### 📌 多源翻译支持

- **本地大模型（Ollama）** — 隐私安全，离线可用，无调用限制
- **云端 API（OpenAI 兼容格式）** — 接入 DeepSeek、OpenRouter 等服务商
- **Google 翻译 / Bing 翻译** — 无需配置，一键切换

### 📄 多格式文档支持

- **PDF 文档** — 默认支持，选中文本自动翻译
- **Markdown 文档** — 在设置中开启"全局"模式后支持

### 🎯 智能交互

- 选中文本自动弹出翻译窗口
- 侧边栏翻译面板，支持手动输入或使用当前选区
- 复制译文 / 重试翻译 / 一键切换语言
- 自定义翻译 Prompt，满足专业需求
- 支持英语、德语、法语、土耳其语、日语和简体中文互译

### 🌐 多语言界面

- 自动跟随 Obsidian 系统语言
- 支持简体中文 / English / Türkçe 界面

### ✏️ 原生 PDF 高亮注释

- **持久化高亮** — 写入标准 PDF 注释，跨 PDF 阅读器可见
- **5 种颜色** — 黄、红、蓝、绿、紫，可配置默认颜色
- **高亮批注** — 点击高亮可添加备注，随 PDF 文件保存
- **切换与撤销** — 再次点击移除高亮，Cmd+Z / Ctrl+Z 撤销

---

## 快速开始

```bash
# 1. 安装 Ollama（macOS / Linux）
curl -fsSL https://ollama.com/install.sh | sh

# 2. 拉取翻译模型（推荐 HY-MT2-1.8B）
ollama pull RogerBen/HY-MT2-1.8B:latest

# 3. 安装插件后，在设置中选择 Local LLM
#    填入端口 http://localhost:11434 和模型名称
#    点击测试验证连接
```

> 💡 **Windows 用户**：请从 [Ollama 官网](https://ollama.com/) 下载安装包，安装后 Ollama 自动在后台运行。

### 安装插件

通过 Terminal 下载并安装：

```bash
# 创建插件目录
mkdir -p YourVault/.obsidian/plugins/llm-translator

# 下载 Release 文件
curl -sL https://github.com/KimFischer99/Obsidian-LLM-Translator/releases/latest/download/main.js \
  -o YourVault/.obsidian/plugins/llm-translator/main.js
curl -sL https://github.com/KimFischer99/Obsidian-LLM-Translator/releases/latest/download/manifest.json \
  -o YourVault/.obsidian/plugins/llm-translator/manifest.json
curl -sL https://github.com/KimFischer99/Obsidian-LLM-Translator/releases/latest/download/styles.css \
  -o YourVault/.obsidian/plugins/llm-translator/styles.css
```

将 `YourVault` 替换为你的 Obsidian 仓库路径。安装后重启 Obsidian，在 **设置 → 社区插件** 中启用 LLM Translator。

---

## 推荐配置

插件安装后，请按以下配置填写：

### 常规设置

| 设置项 | 推荐值 |
|--------|--------|
| 翻译范围 | 全局 |
| 自动翻译选中文本 | 开启 |
| 启用阅读器划词弹窗 | 开启 |

### 服务设置

| 设置项 | 推荐值 |
|--------|--------|
| 翻译服务 | Local LLM |
| 本地模型端口 | `http://localhost:11434` |
| 模型名称 | `RogerBen/HY-MT2-1.8B:latest` |
| 源语言 | Auto |
| 目标语言 | 简体中文 |

### 高级设置

| 设置项 | 推荐值 |
|--------|--------|
| 最大选区长度 | 5000 |
| 选区触发延迟 | 350 毫秒 |
| 请求超时 | 30000 毫秒 |
| Top K | 20 |
| Top P | 0.6 |
| Repeat Penalty | 1.05 |
| Num Predict | 4096 |

---

## 使用指南

### 基本操作

1. **自动翻译** — 选中 PDF 或 Markdown 文本，翻译弹窗自动出现
2. **侧边栏** — 点击左侧工具栏语言图标，打开右侧翻译面板
3. **从侧边栏翻译** — 直接输入文本，或复用 PDF/Markdown 当前选区，再点击翻译按钮

### 翻译范围设置

- **全局** — PDF 和 Markdown 文件均可划词翻译
- **仅 PDF** — 只在 PDF 文件中启用

默认翻译范围为 **全局**。

### 侧边栏功能

- **翻译服务切换** — 快速切换 Local LLM / Cloud API / Google / Bing
- **语言选择** — 设置源语言和目标语言
- **手动输入 / 当前选区** — 直接输入文本，或复用最近一次文档选区
- **Auto-Trans** — 开启/关闭自动翻译
- **Copy** — 复制原文（Raw）、译文（Result）或全部（Both）
- **Clear** — 清空当前翻译记录

### 自定义 Prompt

在 **设置 → 高级 → 自定义 Prompt** 中修改翻译提示词：

```
Translate the following academic text. Preserve technical terminology,
citations, and formulas. Output only the translation.
```

---

## 其他翻译服务

### 云端 API（OpenAI 兼容格式）

支持任意兼容 OpenAI 格式的 API：

| 配置项 | 说明 |
|--------|------|
| API 地址 | 服务商提供的接口地址 |
| API Key | 服务商分配的密钥 |
| 模型名称 | 服务商支持的模型标识 |

### Google 翻译 / Bing 翻译

无需任何配置，在翻译服务下拉菜单中直接选择即可使用。

> ⚠️ 免费翻译服务存在调用频率限制，大量使用建议切换至本地模型或云端 API。

### 隐私与网络访问

- **本地大模型**会把选中文本和翻译 Prompt 发送到配置的 Ollama 端点。使用默认的 `http://localhost:11434` 时，请求仅在本机；改用远程端点时，数据会经网络发送。
- **云端 API**会把选中文本、翻译 Prompt、语言设置和模型标识发送到你配置的 API 地址。服务商可能按其隐私政策保留或处理这些数据。
- **Google 翻译 / Bing 翻译**会把选中文本和语言设置发送给 Google 或 Microsoft 的翻译服务。
- **Cloud API Key** 通过 Obsidian `SecretStorage` 选择或创建；插件的 `data.json` 只保存所选密钥 ID，不保存密钥值。

LLM Translator 0.4.0 要求 Obsidian 1.11.4 或更高版本。Obsidian 的版本解析机制可让旧版应用继续停留在插件 0.3.5。

---

## Windows 注意事项

### Ollama 安装

- 从 [Ollama 官网](https://ollama.com/) 下载 Windows 版安装包
- 安装后自动在后台运行，端口与 macOS 相同：`http://localhost:11434`
- 如遇连接问题，检查 Windows 防火墙是否阻止了本地连接

### 路径格式

- URL 路径使用正斜杠 `/`：`http://localhost:11434`（正确）
- 不要使用反斜杠：`http://localhost:11434\`（错误）

---

## 常见问题

### 测试连接失败？

1. 确认 Ollama 已启动（任务栏应有 Ollama 图标）
2. 在浏览器访问 `http://localhost:11434` 确认服务正常
3. 检查是否有其他程序占用了 11434 端口

### 翻译弹窗不显示？

- 确认已启用"自动翻译选中文本"和"启用阅读器划词弹窗"
- 尝试重启 Obsidian

### Markdown 文件无法翻译？

- 将"翻译范围"设置为"全局"

---

## 开发

```bash
# 安装依赖
npm install

# 开发模式（监听文件变化）
npm run dev

# 生产构建
npm run build

# 自动化行为测试
npm test
```

构建后将 `main.js`、`manifest.json`、`styles.css` 复制到：

```
YourVault/.obsidian/plugins/llm-translator/
```

---

## 许可

MIT License © 2026
