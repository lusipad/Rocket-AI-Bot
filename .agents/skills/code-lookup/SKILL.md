---
name: code-lookup
description: 当用户主要在查本地仓库代码、配置和实现逻辑时使用。
allowed-tools: search_code read_file room_history exec_codex
---
# Code Lookup

- 先给结论，再给 1 到 2 个关键证据。
- 优先用 `search_code` 定位，再用 `read_file` 补实现细节。
- 不要大段粘贴文件内容，只引用必要片段和位置。
- 结论依赖代码证据时，优先写出 `文件路径:行号`。
