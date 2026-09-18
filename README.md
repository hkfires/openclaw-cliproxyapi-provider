# openclaw-cliproxyapi-provider

OpenClaw 的 [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) 模型提供商插件。
通过 OpenAI Responses API 协议（`/v1/responses`）无缝对接 CLIProxyAPI，自动发现与同步上游模型目录，免除手动维护模型列表的繁琐配置。

---

## 特性

- **原生 Responses 协议**：采用 OpenAI Responses API 规范，原生支持流式响应、思考推理过程与结构化输出。
- **自动模型发现**：启动时自动从 CLIProxyAPI 拉取可用模型列表、上下文窗口大小及多模态输入特性。
- **后台定时静默同步**：内置后台刷新机制（默认每 30 分钟），自动感知上游渠道的模型变更，无需重启网关。
- **官方参考定价**：自动匹配 models.dev 的官方基准费率，为 OpenClaw 费用与用量统计提供准确参考。
- **Fast 优先队列支持**：对上游支持 Priority Service Tier 的模型，可一键开启高优先级服务通道。
- **双命名空间兼容**：默认同时注册 `cliproxyapi` 与 `cpa` 前缀，满足规范性与输入便捷性。

---

## 环境要求

- **OpenClaw**：`>=2026.9.4`
- **Node.js**：`>=24.16.0 <25 || >=26.1.0`
- 已运行并就绪的 CLIProxyAPI 实例

---

## 安装

### 方式 1：通过 npm 安装（推荐）

```sh
openclaw plugins install npm:openclaw-cliproxyapi-provider
```

### 方式 2：本地开发链接安装

在本地克隆代码后，先执行构建再进行软链接安装：

```sh
npm ci
npm run build
openclaw plugins install --link /path/to/openclaw-cliproxyapi-provider
openclaw plugins enable cliproxyapi
openclaw gateway restart
```

---

## 配置

插件支持多种配置方式，优先级为：**环境变量 > 本地配置文件 > 宿主凭据存储 > 默认值**。

### 方式 1：通过 OpenClaw 交互式登录（推荐，零环境变量）

在终端中执行登录向导：

```sh
openclaw models auth login --provider cliproxyapi --method api-key
```

按照提示依次输入服务地址（直接回车即默认 `http://127.0.0.1:8317`）及 API Key。插件验证连通性后会将凭据安全保存至 OpenClaw 凭据库中。

### 方式 2：专用配置文件 (`cliproxyapi.json`)

在配置目录（`~/.openclaw/cliproxyapi.json`）中直接维护配置：

```json
{
  "baseUrl": "http://127.0.0.1:8317",
  "apiKey": "your-api-key",
  "fast": false
}
```

> **安全提示**：插件在写入该文件时会自动限制文件访问权限（POSIX `0600`）。在 Windows 系统下，请确保配置文件所在目录的访问控制安全，切勿将包含真实密钥的文件提交至公开版本库。

### 方式 3：环境变量（适合容器化与自动化部署）

同时支持标准全称及 `CPA_*` 简写形式：

| 环境变量（优先全称，兼容简写） | 默认值 | 说明 |
| :--- | :--- | :--- |
| `CLIPROXYAPI_BASE_URL` / `CPA_BASE_URL` | `http://127.0.0.1:8317` | CLIProxyAPI 服务的访问地址 |
| `CLIPROXYAPI_API_KEY` / `CPA_API_KEY` | *(空)* | 访问鉴权 API Key |
| `CLIPROXYAPI_FAST` / `CPA_FAST` | `false` | 是否开启 Priority 优先服务等级（`true` / `false`） |
| `CLIPROXYAPI_PROVIDER_ID` / `CPA_PROVIDER_ID` | `cliproxyapi` | 主 Provider 标识（默认同时注册 `cpa` 别名） |
| `CLIPROXYAPI_PROVIDER_NAME` / `CPA_PROVIDER_NAME`| `CLIProxyAPI` | 显示名称 |

示例：

```sh
export CLIPROXYAPI_BASE_URL="http://127.0.0.1:8317"
export CLIPROXYAPI_API_KEY="your-api-key"
export CLIPROXYAPI_FAST="false"
```

---

## 使用模型

### 1. 切换与设置模型

模型默认注册在 `cliproxyapi/` 命名空间下，并同时提供 `cpa/` 别名：

```sh
# 标准命名空间
openclaw models set cliproxyapi/gpt-4o
openclaw models set cliproxyapi/claude-3-7-sonnet-20250219

# 简写别名（完全等效）
openclaw models set cpa/gpt-4o
openclaw models set cpa/claude-3-7-sonnet-20250219
```

在与智能体对话的交互会话中，也可以直接使用 `/model` 指令即时切换：

```text
/model cpa/gpt-4o
```

### 2. 查看与刷新模型目录

```sh
# 列出当前所有可用模型
openclaw models list --provider cliproxyapi

# 强制触发远程全量发现与刷新
openclaw models list --refresh --all --provider cliproxyapi
```

---

## 后台定时刷新

为了在网关长期运行期间自动同步上游新增或变动的模型，插件内置了后台刷新服务，默认每 **1800 秒（30 分钟）** 静默检查一次模型目录，更新宿主维护的可用列表，期间不会中断现有对话或切换当前模型。

如需调整刷新间隔或关闭，可在 `~/.openclaw/openclaw.json` 中配置：

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

- `refreshIntervalSeconds`：支持设置为 `30` 至 `86400` 秒之间的整数；设置为 `0` 表示关闭后台定时刷新。修改配置后重启网关生效。

---

## 开发与测试

```sh
# 安装开发依赖
npm ci

# 代码格式化检查与静态类型检查
npm run check

# 运行单元测试
npm test

# 运行 OpenClaw 宿主集成测试与后台刷新测试
npm run test:host
npm run test:refresh

# 生产环境编译构建
npm run build
```

---

## 许可证

MIT © [hkfires](https://github.com/hkfires)
