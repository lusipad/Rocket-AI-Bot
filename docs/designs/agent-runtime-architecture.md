# Agent Runtime Architecture

## Why this exists

RocketBot is moving from a Rocket.Chat bot with an LLM orchestrator into a reusable Agent runtime. The product center should be the Agent. Rocket.Chat, scheduler tasks, Admin, and future CLI/API entry points are adapters.

The current codebase is in a migration state:

- `src/agent-core` provides `AgentRequest`, `AgentResponse`, request classification, and capability routing.
- `src/skills` owns project `SKILL.md` discovery and lazy instruction loading.
- `src/agent/orchestrator.ts` still owns the main LLM tool loop, control commands, and active skill prompt injection.
- Rocket.Chat and scheduler paths already enter through `AgentRuntime`, but the runtime is not yet fully skill-first.

This document defines the target shape and the migration boundary.

## Capability Model

```text
Agent = task runtime
Skill = loadable capability package
Tool = atomic operation a skill/runtime may call
Workflow = multi-step skill/task lifecycle
Adapter = input/output integration such as Rocket.Chat, Scheduler, HTTP, CLI
```

An Agent runtime must provide:

1. Task intake: normalize adapter input into `AgentRequest`.
2. Routing: classify intent and select skills/capabilities.
3. Skill loading: discover manifests first, load full instructions only when needed.
4. Context: attach room/thread history, summaries, memory, and artifacts.
5. Execution: run deterministic handlers, LLM tool loops, or workflows.
6. Control: model routing, deep mode, timeout, cancel, retry, resume.
7. Verification: source grounding, tool evidence, tests, and error reporting.
8. Observability: `requestId`, trace, sources, tools, metrics, and artifacts.

## Target Shape

```text
Rocket.Chat       Scheduler        HTTP/Admin        CLI/API
    |                 |                |               |
    +-----------------+----------------+---------------+
                              |
                              v
                       Adapter Layer
                              |
                              v
                       AgentRuntime
                              |
                              v
                         AgentTask
                 plan / execute / verify / report
                              |
                              v
                       SkillRuntime
        +---------------------+----------------------+
        |                     |                      |
        v                     v                      v
 SkillCatalog          SkillRouter            SkillLoader
 desc only             match/rank             lazy body load
        |                     |                      |
        +---------------------+----------------------+
                              |
                              v
                       SkillExecutor
             deterministic / LLM tool loop / workflow
                              |
          +-------------------+-------------------+
          |                   |                   |
          v                   v                   v
       Tools              Context             Artifacts
 local code, ADO,      history, memory,      files, links,
 web, room history     summaries             reports
          |                   |                   |
          +-------------------+-------------------+
                              |
                              v
                 Trace / Sources / Metrics Store
```

## Boundary Rules

- Adapters may create `AgentRequest` and render `AgentResponse`; they must not know how skills are loaded or executed.
- Scheduler and Rocket.Chat should call `AgentRuntime`, not `Orchestrator`.
- `AgentRuntime` may bridge to the legacy `Orchestrator` during migration, but new behavior should enter through the Agent boundary.
- Skill discovery must be manifest-first: name, description, allowed tools, enabled state, and file path only.
- Full `SKILL.md` instructions are loaded only for selected or explicitly requested skills.
- Explicit `$skill` requests should route through skill handling before deterministic capability fast paths.
- Deterministic fast paths should become built-in skills over time. `Capability` remains a migration mechanism, not the final capability model.
- Observability belongs to Agent execution: every run should be traceable by `requestId`, request type, tools, sources, and status.

## Current Public Boundary

New code should import Agent-facing APIs from `src/agent-runtime` instead of reaching into `src/agent-core` or `src/skills` directly.

```text
src/agent-runtime
  index.ts          public facade
  skill-catalog.ts  Agent-side skill discovery/loading facade
  skill-runtime.ts  first skill routing surface for explicit skill preflight

src/agent-core      migration implementation detail
src/skills          project skill storage/legacy registry
src/agent           legacy LLM orchestration bridge
```

## Skill-First Runtime Contract

```text
Skill manifest:
  name
  description
  allowedTools
  enabled
  filePath

Skill detail:
  manifest fields
  directory
  instructions

Skill execution forms:
  deterministic handler
  LLM tool loop
  workflow runner
```

The runtime must be able to list manifests without reading full instructions. This keeps context small and matches the official skill-loading pattern: discover by description, load body on demand.

## Migration Plan

1. Establish `src/agent-runtime` as the public internal boundary.
2. Wrap project `SkillRegistry` behind an Agent-side `SkillCatalog`.
3. Add `SkillRuntime` for explicit skill preflight and routing metadata.
4. Move deterministic capabilities into built-in skill descriptors.
5. Move skill selection out of legacy `Orchestrator` and into `SkillRuntime`.
6. Reduce `Orchestrator` to an `llm-tool-loop` executor.
7. Add `AgentTask` lifecycle for plan, execute, verify, artifacts, and resumable traces.
8. Keep Rocket.Chat, scheduler, Admin, and future CLI/API as thin adapters.

## Near-Term Non-Goals

- Do not split into a separate repo yet.
- Do not run Agent as a separate service yet.
- Do not rewrite all legacy Orchestrator behavior in one change.
- Do not invent a broad plugin system before SkillRuntime has a stable contract.
