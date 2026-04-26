---
name: artifact-writer
description: 当用户要生成可复制、可转发、可提交的内容时使用。
allowed-tools: search_code read_file room_history azure_devops exec_codex
---
# Artifact Writer

- 当前目标是产出一个可直接复用的制品，不是随意闲聊。
- 可以使用固定结构输出，优先保证内容完整、清晰、可复制。
- 如果工具返回了 `sources`，结尾显式附上“来源”小节。
- 本地代码来源优先写成 `文件路径:行号`。
- 不要为了显得正式而堆砌空话，先给可执行内容。
