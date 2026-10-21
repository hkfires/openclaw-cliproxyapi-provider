# CLIProxyAPI Provider

[English](#english) | [简体中文](#简体中文)

## English

A [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) (CPA) model provider plugin for [OpenClaw](https://github.com/openclaw).
Connects through the OpenAI Responses protocol, automatically discovers and syncs models, and supports chat and image generation.

### Features

- **Ready to use**: Automatically discovers available models, context windows, and multimodal input capabilities.
- **Chat and images**: Supports chat through the Responses protocol, plus text-to-image generation and reference-image editing through `/v1/images/*`.
- **Background sync**: Periodically refreshes the upstream model catalog without restarting the Gateway.
- **Reference pricing**: Matches models.dev reference rates for usage tracking.

### Requirements

- **OpenClaw**: `>=2026.9.4`
- **Node.js**: `>=24.16.0 <25 || >=26.1.0`
- A running CLIProxyAPI instance

### Installation

Choose one method below. Both the plugin ID and Provider ID are `cliproxyapi`, and the model prefix is `cliproxyapi/`. Existing configurations do not need to change.

#### Install from ClawHub

```sh
openclaw plugins install clawhub:openclaw-cliproxyapi-provider
```

#### Install from npm

```sh
openclaw plugins install npm:openclaw-cliproxyapi-provider
```

#### Local development

```sh
git clone https://github.com/hkfires/openclaw-cliproxyapi-provider.git
cd openclaw-cliproxyapi-provider
npm ci && npm run build
openclaw plugins install --link .
openclaw plugins enable cliproxyapi
openclaw gateway restart
```

### Configuration

#### Option 1: Interactive login (recommended)

Run the login wizard to enter your service URL (press Enter for `http://127.0.0.1:8317`) and API key, then optionally select chat, vision, and image-generation models. Vision choices are filtered to models that support image input.

```sh
openclaw models auth login --provider cliproxyapi --method api-key --set-default --agent main
```

Replace `main` with your Agent ID if needed. In multi-Agent setups, use `--agent` to assign credentials to the intended Agent; model defaults still apply globally.

#### Option 2: Environment variables

The full variable name takes precedence over its short alias.

| Environment variable | Default | Description |
| :--- | :--- | :--- |
| `CLIPROXYAPI_BASE_URL` / `CPA_BASE_URL` | `http://127.0.0.1:8317` | CLIProxyAPI service URL |
| `CLIPROXYAPI_API_KEY` / `CPA_API_KEY` | *(empty)* | API key |
| `CLIPROXYAPI_FAST` / `CPA_FAST` | `false` | Enable the Priority service tier |

### Usage

#### 1. Chat models

Use the `cliproxyapi/` prefix:

```sh
# Set the primary model
openclaw models set cliproxyapi/gpt-4o

# Switch models within a conversation
/model cliproxyapi/claude-3-7-sonnet-20250219
```

#### 2. List and refresh models

```sh
# List available models
openclaw models list --provider cliproxyapi

# Force a full refresh from the upstream service
openclaw models list --refresh --all --provider cliproxyapi
```

#### 3. Image generation and editing

If the backend model supports `/v1/images/*`, generate and edit images directly through OpenClaw:

```sh
# Generate an image
openclaw infer image generate --model cliproxyapi/gpt-image-2 --prompt "A cozy wooden cabin in the snow" --output ./cabin.png

# Edit a reference image
openclaw infer image edit --model cliproxyapi/gpt-image-2 --file ./cabin.png --prompt "Change the scene to summer with green grass" --output ./cabin-summer.png
```

### Optional settings

Set the background model refresh interval in `~/.openclaw/openclaw.json` (default: 1800 seconds; `0` disables it):

```json
{
  "plugins": {
    "entries": {
      "cliproxyapi": {
        "enabled": true,
        "config": {
          "refreshIntervalSeconds": 1800
        }
      }
    }
  }
}
```

### Development and testing

```sh
npm run check          # Type checking, linting, and unit tests
npm test               # Unit tests
npm run test:host      # OpenClaw host integration tests
npm run test:images    # Image generation and editing tests
npm run build          # Build
```

### License

MIT © [hkfires](https://github.com/hkfires)

---

## 简体中文

[OpenClaw](https://github.com/openclaw) 的 [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) (CPA) 模型提供商插件。
通过 OpenAI Responses 协议对接 CLIProxyAPI，自动发现与同步模型列表，支持对话与图片生成。

### 特性

- **即开即用**：自动拉取可用模型目录、上下文窗口及多模态输入配置。
- **对话与生图**：支持文本对话（Responses 协议）及文生图 / 参考图编辑（`/v1/images/*`）。
- **后台自动同步**：定时静默更新上游模型目录，感知渠道变动无需重启网关。
- **官方参考定价**：自动匹配 models.dev 基准费率，便于统计用量。

### 环境要求

- **OpenClaw**：`>=2026.9.4`
- **Node.js**：`>=24.16.0 <25 || >=26.1.0`
- 运行中的 CLIProxyAPI 实例

### 安装

以下方式任选其一。插件 ID 和 Provider ID 均为 `cliproxyapi`，模型前缀为 `cliproxyapi/`，现有配置无需修改。

#### 通过 ClawHub 安装

```sh
openclaw plugins install clawhub:openclaw-cliproxyapi-provider
```

#### 通过 npm 安装

```sh
openclaw plugins install npm:openclaw-cliproxyapi-provider
```

#### 本地开发安装

```sh
git clone https://github.com/hkfires/openclaw-cliproxyapi-provider.git
cd openclaw-cliproxyapi-provider
npm ci && npm run build
openclaw plugins install --link .
openclaw plugins enable cliproxyapi
openclaw gateway restart
```

### 配置

#### 方式 1：交互式登录（推荐）

运行登录向导，根据提示输入服务地址（回车默认 `http://127.0.0.1:8317`）与 API Key，并按需选择主对话模型、识图理解模型（自动筛选支持看图的模型）及文生图模型：

```sh
openclaw models auth login --provider cliproxyapi --method api-key --set-default --agent main
```

若自定义了 Agent 名称，将 `main` 替换为对应 Agent ID。多 Agent 环境需带上 `--agent` 认领凭据，模型默认值仍全局生效。

#### 方式 2：环境变量

环境变量优先使用全称，兼容简写。

| 环境变量 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `CLIPROXYAPI_BASE_URL` / `CPA_BASE_URL` | `http://127.0.0.1:8317` | CLIProxyAPI 服务地址 |
| `CLIPROXYAPI_API_KEY` / `CPA_API_KEY` | *(空)* | API Key |
| `CLIPROXYAPI_FAST` / `CPA_FAST` | `false` | 是否开启 Priority 优先服务等级 |

### 使用指南

#### 1. 对话模型

使用 `cliproxyapi/` 前缀：

```sh
# 设置主模型
openclaw models set cliproxyapi/gpt-4o

# 对话中即时切换
/model cliproxyapi/claude-3-7-sonnet-20250219
```

#### 2. 查看与刷新模型

```sh
# 查看当前可用模型
openclaw models list --provider cliproxyapi

# 强制从上游刷新全量模型列表
openclaw models list --refresh --all --provider cliproxyapi
```

#### 3. 图片生成与编辑

若后端模型支持 `/v1/images/*`，可直接通过 OpenClaw 进行文生图和参考图编辑：

```sh
# 文生图
openclaw infer image generate --model cliproxyapi/gpt-image-2 --prompt "A cozy wooden cabin in the snow" --output ./cabin.png

# 参考图编辑
openclaw infer image edit --model cliproxyapi/gpt-image-2 --file ./cabin.png --prompt "Change the scene to summer with green grass" --output ./cabin-summer.png
```

### 可选配置

在 `~/.openclaw/openclaw.json` 中可调整后台模型刷新频率（默认 1800 秒，填 `0` 则禁用）：

```json
{
  "plugins": {
    "entries": {
      "cliproxyapi": {
        "enabled": true,
        "config": {
          "refreshIntervalSeconds": 1800
        }
      }
    }
  }
}
```

### 开发与测试

```sh
npm run check          # 类型检查、代码格式与单元测试
npm test               # 单元测试
npm run test:host      # OpenClaw 宿主集成测试
npm run test:images    # 生图与编辑能力测试
npm run build          # 构建
```

### 许可证

MIT © [hkfires](https://github.com/hkfires)
