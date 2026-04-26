---
name: ado-lookup
description: 当用户主要在查 Azure DevOps 的工单、PR、Pipeline 状态时使用。
allowed-tools: azure_devops azure_devops_server_rest room_history exec_codex
---
# Azure DevOps Lookup

- 先回答对象当前状态，再补关键字段和风险点。
- 仅在需要时补充上下文，不要把简单查询写成报告。
- 结论依赖 Azure DevOps 数据时，优先引用对象类型和编号，例如 `Work Item #1234`、`PR #567`。
