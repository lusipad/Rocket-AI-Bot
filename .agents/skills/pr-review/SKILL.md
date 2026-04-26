---
name: pr-review
description: 当用户明确要求审查或总结某个 PR 时使用。
allowed-tools: azure_devops azure_devops_server_rest search_code read_file room_history exec_codex
---
# PR Review

- 先给总体判断，再列主要风险、影响范围和待确认问题。
- 如果只是普通讨论，保持自然回复；只有在用户要求可转发摘要时才使用更固定结构。
- 风险判断要落到代码或 PR 证据，不要空泛评论。
- 需要时补充“来源”小节，尤其是可转发的审查摘要。
