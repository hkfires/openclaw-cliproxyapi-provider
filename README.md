# openclaw-cliproxyapi-provider

[OpenClaw](https://github.com/openclaw) 的 [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) (CPA) 模型提供商插件。
通过 OpenAI Responses 协议对接 CLIProxyAPI，自动发现与同步模型列表，支持对话与图片生成。

---

## 特性

- **即开即用**：自动拉取可用模型目录、上下文窗口及多模态输入配置。
- **对话与生图**：支持文本对话（Responses 协议）及文生图 / 参考图编辑（`/v1/images/*`）。
- **后台自动同步**：定时静默更新上游模型目录，感知渠道变动无需重启网关。
- **双前缀别名**：同时支持 `cliproxyapi/` 与 `cpa/` 前缀。
- **官方参考定价**：自动匹配 models.dev 基准费率，便于统计用量。

---

## 环境要求

- **OpenClaw**：`>=2026.9.4`
- **Node.js**：`>=24.16.0 <25 || >=26.1.0`
- 运行中的 CLIProxyAPI 实例

---

## 安装

### 通过 npm 安装

```sh
openclaw plugins install npm:openclaw-cliproxyapi-provider
```

### 本地开发安装

```sh
git clone https://github.com/hkfires/openclaw-cliproxyapi-provider.git
cd openclaw-cliproxyapi-provider
npm ci && npm run build
openclaw plugins install --link .
openclaw plugins enable cliproxyapi
openclaw gateway restart
```

---

## 配置

### 方式 1：交互式登录（推荐）

运行登录向导，根据提示输入服务地址（回车默认 `http://127.0.0.1:8317`）与 API Key，并选择主模型及生图模型：

```sh
openclaw models auth login --provider cliproxyapi --method api-key --set-default
```

### 方式 2：环境变量

| 环境变量（优先全称，兼容简写） | 默认值 | 说明 |
| :--- | :--- | :--- |
| `CLIPROXYAPI_BASE_URL` / `CPA_BASE_URL` | `http://127.0.0.1:8317` | CLIProxyAPI 服务地址 |
| `CLIPROXYAPI_API_KEY` / `CPA_API_KEY` | *(空)* | API Key |
| `CLIPROXYAPI_FAST` / `CPA_FAST` | `false` | 是否开启 Priority 优先服务等级 |

---

## 使用指南

### 1. 对话模型

支持使用 `cliproxyapi/` 或简写 `cpa/`：

```sh
# 设置主模型
openclaw models set cpa/gpt-4o

# 对话中即时切换
/model cpa/claude-3-7-sonnet-20250219
```

### 2. 查看与刷新模型

```sh
# 查看当前可用模型
openclaw models list --provider cliproxyapi

# 强制从上游刷新全量模型列表
openclaw models list --refresh --all --provider cliproxyapi
```

### 3. 图片生成与编辑

若后端模型支持 `/v1/images/*`，可直接通过 OpenClaw 进行文生图和参考图编辑：

```sh
# 文生图
openclaw infer image generate --model cpa/gpt-image-2 --prompt "A cozy wooden cabin in the snow" --output ./cabin.png

# 参考图编辑
openclaw infer image edit --model cpa/gpt-image-2 --file ./cabin.png --prompt "Change the scene to summer with green grass" --output ./cabin-summer.png
```

---

## 可选配置

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

---

## 开发与测试

```sh
npm run check          # 类型检查与代码格式
npm test               # 单元测试
npm run test:host      # OpenClaw 宿主集成测试
npm run test:images    # 生图与编辑能力测试
npm run build          # 构建
```

---

## 许可证

MIT © [hkfires](https://github.com/hkfires)
