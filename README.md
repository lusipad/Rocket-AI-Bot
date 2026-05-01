# Rocket AI Bot

一个运行在 Rocket.Chat 中的企业内 AI 助手，支持多轮上下文、图片理解、模型原生联网搜索、本地仓库检索、Codex CLI 调用、Azure DevOps 查询，以及一个轻量的 Web 管理界面。

## 当前能力

- Rocket.Chat `@机器人` 对话
- 基于最近消息的会话上下文拼接，支持“继续”“刚才那个”“那张图”等追问
- 当前消息和最近上下文中的图片输入
- OpenAI 兼容 LLM 接入，支持 `chat_completions` / `responses` 模式探测
- 本地仓库代码搜索和文件读取
- 可选调用本地 Codex CLI 处理复杂编程任务
- 查询 Azure DevOps Server 的工作项、PR 和流水线
- 显式深度模式：`|deep` 使用深度模型，`|normal` / `|deep off` 退出
- 通用 Agent Runtime 基础：默认 RocketBot Agent 已抽象为可观测的 Agent 定义
- 项目级 Skills：启动只加载元数据，按需读取 `SKILL.md` 正文
- Web 管理页、Skill 管理、上下文治理和定时任务调度

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
LLM_DEEP_MODEL=your-deep-model
LLM_API_MODE=chat_completions

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
- `llm.apiMode`：当前推荐 `chat_completions`；如果供应商支持 Responses API，可在管理页探测后切换
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

## 聊天指令

Rocket.Chat 对 `/` 前缀有限制，推荐使用 `|` 前缀；`/` 前缀仍作为兼容别名保留。

| 指令 | 作用 |
| --- | --- |
| `|help` | 查看可用指令 |
| `|status` | 查看当前模式、模型、API 模式、深度模式剩余时间和服务状态 |
| `|deep` | 进入深度模式，后续请求使用 `LLM_DEEP_MODEL`，30 分钟后自动退出 |
| `|normal` | 退出深度模式，恢复 `LLM_MODEL` |
| `|deep off` | 退出深度模式，等价于 `|normal` |
| `|context` | 查看当前上下文策略 |
| `|context reset` | 清除当前房间或 thread 的缓存摘要，不删除 Rocket.Chat 真实聊天记录 |
| `|skills` | 查看当前已启用 skills |

深度模式只接受显式指令开关；普通消息里出现“深入分析”“复杂问题”等词不会自动切换模型。

## 访问入口

- 健康检查：`GET /api/health`
- 状态接口：`GET /api/status`
- 任务接口：`/api/tasks`
- Skill 接口：`/api/skills`
- 管理页面：`http://localhost:<WEB_PORT>/admin`

如果设置了 `WEB_SECRET`，除 `/api/health` 外的 `/api/*` 请求都需要 `Authorization: Bearer <WEB_SECRET>`。

## Skill 管理

管理页 `Skills` 支持这些操作：

- 查看项目内已装载的 skill
- 启用或禁用 skill
- 重新扫描 `.agents/skills`
- 查看 skill 详情和 `SKILL.md` 指令
- 卸载项目内 skill
- 从 Git 仓库安装 skill

安装方式：

- 在 `Skills` 页填写 `Git 仓库地址或本地仓库路径`
- 如果仓库里只有一个 `SKILL.md`，会自动识别
- 如果仓库里有多个 skill，需要填写子目录

当前安装能力的边界：

- 仅支持从 Git 仓库安装
- 不支持在线编辑 skill
- 不做依赖安装或插件市场

## 上下文治理

管理页 `上下文` 用来调整 Bot 在后台如何读取聊天上下文，普通用户的使用方式不变：

- 私聊、群聊和 thread 可分别配置普通请求读取多少条最近消息
- 讨论型请求（例如“总结上面”“梳理刚才的分歧”）可配置更大的读取窗口
- 公开频道可限制回看时间窗口，避免长期公共频道把很久以前的无关内容带进来
- 可启用讨论摘要缓存，让多轮讨论后的总结、回顾和待办梳理更稳定
- 可在管理页查看、清空或重建某个房间/thread 的摘要缓存

请求详情页会展示本次实际使用的上下文范围、最近消息数量、摘要是否注入、图片数量、联网搜索状态和模型模式。排查“为什么这次回答用了哪些上下文”时，优先看 `请求` 页面里的详情。

## Agent Runtime

当前默认 Agent 是 `rocketbot-default`，运行在 Rocket.Chat 和 scheduler 两个入口上。它仍然保持现有聊天体验：群聊需要 `@RocketBot`，私聊无需 `@`，定时任务继续走后台调度。

这一层的目标是把模型、深度模型、渠道、skill 策略和上下文策略引用沉淀成通用 Agent 定义。管理端状态页和请求详情页会显示本次使用的 Agent，方便后续扩展为多 Agent、MCP tools 和更通用的 channel adapter。

## 验证命令

```bash
npm test
npm run lint
npm run build
npm --prefix web-admin run build
```

真实环境 smoke：

```bash
npm run smoke:commands
npm run smoke:skills
```

`npm run smoke:commands` 会直接连接当前正在运行的本地 RocketBot 和 Rocket.Chat，验证：

- `|help`、`|status`、`|skills`、`|context reset`
- 自然语言“深入分析”仍保持普通模式
- `|deep` 后切到 `LLM_DEEP_MODEL`
- `|normal` 后恢复 `LLM_MODEL`
- 请求日志里的 `context.modelMode` 对控制指令和普通消息都正确

`npm run smoke:skills` 会直接连接你当前正在运行的本地 RocketBot 和 Rocket.Chat，自动完成：

- 复用或注册一个 smoke 测试用户
- 创建临时私有群并把 bot 拉进去
- 发送一条群聊 `code-lookup` 请求
- 发送几条私聊请求，验证 `ado-lookup`、`pr-review`
- 额外观察一次 `artifact-writer` 是否会由模型自行触发
- 轮询 `data/requests/history` 校验 `activeSkills`、`skillSources`、`usedTools`
- 删除临时私有群

注意：

- 脚本不会自动启动 bot；运行前先确认 `http://127.0.0.1:<WEB_PORT>/api/health` 正常
- 默认使用 `rocketbot_smoke / RocketBotSmoke!2026` 作为测试账号；也可以用 `SMOKE_RC_USERNAME`、`SMOKE_RC_PASSWORD`、`SMOKE_RC_EMAIL`、`SMOKE_RC_NAME` 覆盖
- `artifact-writer` 那一步是观测项，不作为脚本失败条件，因为它依赖模型是否主动触发

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

- 管理端目前覆盖状态查看、任务管理、Skill 管理、上下文治理和请求历史；完整系统配置仍通过 `.env` 与 `config/default.yaml` 管理
- 是否能使用模型原生联网搜索，取决于你接入的 OpenAI 兼容接口是否真正支持 Responses API 与搜索工具
- `exec_codex` 只在本机安装并配置 Codex CLI 后可用
