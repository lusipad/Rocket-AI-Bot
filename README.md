# Rocket AI Bot

一个运行在 Rocket.Chat 中的企业内 AI 助手，支持多轮上下文、图片理解、模型原生联网搜索、本地仓库检索、Codex CLI 调用、Azure DevOps 查询，以及一个轻量的 Web 管理界面。

## 当前能力

- Rocket.Chat `@机器人` 对话
- 基于最近消息的会话上下文拼接，支持“继续”“刚才那个”“那张图”等追问
- 当前消息和最近上下文中的图片输入
- 基于 OpenAI Responses API 的模型原生联网搜索
- 本地仓库代码搜索和文件读取
- 可选调用本地 Codex CLI 处理复杂编程任务
- 查询 Azure DevOps Server 的工作项、PR 和流水线
- Web 管理页和定时任务调度

## 目录结构

```text
.
|-- config/default.yaml      # 主配置
|-- src/                     # Bot / LLM / tools / web server
|-- tests/                   # Node 原生测试
|-- web-admin/               # React 管理端源码
|-- src/web/admin/           # 管理端构建产物（运行时静态资源）
|-- ecosystem.config.js      # PM2 配置
`-- .env.example             # 环境变量示例
```

## 环境要求

- Node.js 22
- 一个可登录的 Rocket.Chat 实例
- 一个 OpenAI 兼容接口；如果要启用原生联网搜索，所选模型和接口需要支持 Responses API 与 `web_search`
- 可选：Azure DevOps Server + PAT
- 可选：本地 Codex CLI

## 快速开始

1. 安装依赖。

```bash
npm install
npm --prefix web-admin install
```

2. 复制 `.env.example` 为 `.env`，至少填写这些变量。

```env
RC_HOST=your-rocket-chat-host
RC_USE_SSL=true
RC_USERNAME=bot
RC_PASSWORD=your-password

LLM_ENDPOINT=https://your-openai-compatible-endpoint/v1
LLM_API_KEY=your-api-key
LLM_MODEL=your-model

AZURE_DEVOPS_URL=http://your-ad-server:8080/tfs
AZURE_DEVOPS_PAT=your-pat
AZURE_DEVOPS_PROJECT=DefaultCollection

WEB_PORT=3001
WEB_SECRET=change-this
```

3. 按你的环境调整 `config/default.yaml`。

- `repos[*].path`：允许搜索的本地仓库根目录，默认是当前项目目录 `.`
- `codex.path`：本地 Codex CLI 可执行文件路径；留空则不注册该工具
- `codex.workingDir`：Codex CLI 默认工作目录
- `llm.apiMode`：默认 `responses`
- `llm.nativeWebSearch.enabled`：默认开启；如果你的供应商不支持，请关闭

4. 构建并启动。

```bash
npm run build
npm --prefix web-admin run build
npm start
```

开发模式：

```bash
npm run dev
```

管理端源码开发：

```bash
npm run web-admin:dev
```

## 访问入口

- 健康检查：`GET /api/health`
- 状态接口：`GET /api/status`
- 任务接口：`/api/tasks`
- 管理页面：`http://localhost:<WEB_PORT>/admin`

如果设置了 `WEB_SECRET`，除 `/api/health` 外的 `/api/*` 请求都需要 `Authorization: Bearer <WEB_SECRET>`。

## 验证命令

```bash
npm test
npm run lint
npm run build
npm --prefix web-admin run build
```

## CI

仓库内置 GitHub Actions 工作流 `.github/workflows/ci.yml`，在推送到 `main` 或提交 PR 到 `main` 时执行：

- `npm ci`
- `npm --prefix web-admin ci`
- `npm test`
- `npm run lint`
- `npm run build`
- `npm --prefix web-admin run build`

这套 CI 只做静态验证和单元测试，不连接真实 Rocket.Chat、LLM 或 Azure DevOps。

## 隐私与运行数据

- 不要提交 `.env`
- `data/`、日志、构建缓存都已在 `.gitignore` 中排除
- 运行日志可能包含访问令牌等敏感上下文，日志目录应仅用于本地或受控环境

## 已知边界

- 管理端目前只覆盖状态查看、任务管理和历史查看，不提供完整在线配置编辑
- 是否能使用模型原生联网搜索，取决于你接入的 OpenAI 兼容接口是否真正支持 Responses API 与搜索工具
- `exec_codex` 只在本机安装并配置 Codex CLI 后可用
