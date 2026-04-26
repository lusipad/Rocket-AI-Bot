# RocketBot 运维说明

## 启动与重启

本地构建并启动：

```bash
npm run build
npm --prefix web-admin run build
npm start
```

当前项目用 `data/rocketbot.lock` 记录运行中的进程 PID。需要手动重启时，先停止该 PID，再重新启动 `dist/index.js`：

```powershell
$pid = [int](Get-Content data\rocketbot.lock)
Stop-Process -Id $pid
npm start
```

如果端口被占用，优先检查 `.env` 里的 `WEB_PORT`，再看占用进程：

```powershell
Get-NetTCPConnection -LocalPort 4312 -ErrorAction SilentlyContinue
```

## 健康检查

健康接口不需要鉴权：

```bash
curl http://127.0.0.1:<WEB_PORT>/api/health
```

期望结果：

```json
{
  "status": "ok",
  "connections": {
    "rocketchat": "connected",
    "llm": "CLOSED"
  }
}
```

说明：

- `rocketchat=connected` 表示 DDP 消息订阅已连接。
- `llm=CLOSED` 表示 LLM 熔断器关闭，当前可请求。
- 如果出现 DDP close，RocketBot 会标记离线并自动重连。

带鉴权的状态接口：

```powershell
$secret = (Select-String -Path .env -Pattern '^WEB_SECRET=').Line -replace '^WEB_SECRET=',''
Invoke-RestMethod -Uri http://127.0.0.1:<WEB_PORT>/api/status -Headers @{ Authorization = "Bearer $secret" }
```

## LLM 配置

当前推荐配置形态：

```env
LLM_ENDPOINT=https://api.gettoken.dev/v1
LLM_API_KEY=...
LLM_MODEL=gpt-5.5
LLM_DEEP_MODEL=gpt-5.5-pro
LLM_API_MODE=chat_completions
```

旧 endpoint 或测试 key 可以保留在 `.env` 里，但应注释掉，不要删除正在对比的配置。

如果要确认供应商支持哪种 API 模式，使用管理页 `/admin/config` 的 LLM API 模式探测。探测只给推荐值，不会自动修改 `.env`。

## 聊天指令

推荐使用 `|` 前缀：

| 指令 | 用途 |
| --- | --- |
| `|help` | 查看指令 |
| `|status` | 查看当前模型、深度模式、剩余退出时间和服务状态 |
| `|deep` | 进入深度模式，使用 `LLM_DEEP_MODEL` |
| `|normal` | 退出深度模式，恢复 `LLM_MODEL` |
| `|deep off` | 退出深度模式 |
| `|context` | 查看上下文策略 |
| `|context reset` | 清除当前房间/thread 的缓存摘要 |
| `|skills` | 查看已启用 skills |

深度模式规则：

- 只由 `|deep` 显式开启。
- 普通消息不会因为包含“深入分析”“复杂问题”等词自动进入深度模式。
- 会话级深度模式 30 分钟后自动退出。
- 也可以用 `|normal` 或 `|deep off` 立即退出。

## 真实链路验证

运行前先确认服务已启动且健康接口正常。

指令和模型模式验证：

```bash
npm run smoke:commands
```

覆盖内容：

- `|help`、`|status`、`|skills`、`|context reset`
- 自然语言“深入分析”仍走普通模型
- `|deep` 后走深度模型
- `|normal` 后恢复普通模型
- 请求日志里的 `context.modelMode` 正确

Skill 触发验证：

```bash
npm run smoke:skills
```

覆盖内容：

- 显式 skill：`code-lookup`、`ado-lookup`、`pr-review`
- 模型自触发 skill：`artifact-writer` 作为观测项
- 请求日志中的 `activeSkills`、`skillSources`、`usedTools`

## 常见排障

### Bot 看起来在线但不回消息

先看健康接口：

```bash
curl http://127.0.0.1:<WEB_PORT>/api/health
```

如果 `rocketchat=disconnected`，等待自动重连或重启服务。日志里出现 `[ddp] Close (...)` 时，当前版本会自动置离线并安排重连。

如果健康接口正常但真实消息无响应，跑：

```bash
npm run smoke:commands
```

失败时根据输出的 `requestId` 到管理页请求记录里查详情。

### 深度模式没退出

在同一房间或 thread 发送：

```text
|normal
```

再发送：

```text
|status
```

确认模式显示为普通模式。

### LLM API 模式不兼容

症状通常是普通请求失败，但 Rocket.Chat 连接正常。处理顺序：

1. 打开 `/admin/config`
2. 运行 LLM API 模式探测
3. 如果 `responses` 失败、`chat_completions` 成功，将 `.env` 设置为 `LLM_API_MODE=chat_completions`
4. 重启服务
5. 运行 `npm run smoke:commands`

### Skill 没有触发

先在聊天里发送：

```text
|skills
```

确认目标 skill 已启用。再运行：

```bash
npm run smoke:skills
```

如果显式 `$skill-name` 能触发，但自然语言不能触发，通常是模型没有选择调用 `activate_skill`，可以在请求记录里查看 `skillSources`。
