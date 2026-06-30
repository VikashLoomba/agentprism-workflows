# AgentPrism Workflows

Run **dynamic, multi-agent workflow scripts** — `agent()`, `parallel()`, `pipeline()` — over real coding agents (Claude Code and OpenAI Codex), with deterministic journaling, resume, token budgets, and git-worktree isolation.

You author a small JavaScript *script* (`export const meta`, then call `agent()` / `parallel()` / `pipeline()`); the engine runs it in a sandboxed realm, fanning each `agent()` call out to an [Agent Client Protocol](https://agentclientprotocol.com) (ACP) backend. It's available two ways:

- **As a TypeScript SDK** — `@automatalabs/workflows` — embed the runner in your own program.
- **As a stdio MCP server** — `@automatalabs/mcp-server` — expose a `workflow` tool to any MCP host (Claude Code, Zed, …).

> **Status: pre-release.** The packages are versioned `0.1.0` under the `@automatalabs` scope and are being prepared for npm. Until they're published, install from source (see [Install](#install)). The `npm i …` lines below are how it will work once published.

---

## How it works

One process plays **two protocol roles at once**: it's an **MCP server** (or a library) that accepts a workflow script, and an **ACP client** that drives one or more agent subprocesses to execute each `agent()` call.

```
   your program  ──or──  MCP host (Claude Code / Zed / …)
        │  runDynamicWorkflow(script)      calls tool "workflow"
        ▼
┌──────────────────────────────────────────────┐
│  AgentPrism orchestrator                      │
│   • the deterministic engine runs the script  │
│   • ACP CLIENT → drives agent servers         │
└──────────────────────────────────────────────┘
        │  session/new, session/prompt … (ACP, JSON-RPC over stdio)
        ▼
   claude-agent-acp / codex-acp   (long-lived, pooled subprocesses)
        │  → real Claude / Codex agents, one session per agent() call
```

The deterministic engine (sandboxed `vm` realm, `parallel`/`pipeline`, journal/resume, token budget, worktree isolation) is independent of *how* a single agent runs and of *how* the tool is exposed. See [`docs/design-notes.md`](docs/design-notes.md) for the full protocol-level design.

---

## Requirements

- **Node.js ≥ 22** and **pnpm ≥ 10** (see `.nvmrc` / `packageManager`).
- A backend agent CLI, authenticated on your machine:
  - **Claude** — via the bundled `@agentclientprotocol/claude-agent-acp`; auth from `~/.claude/.credentials.json` or `ANTHROPIC_API_KEY` (the orchestrator inherits your environment).
  - **Codex** — via `@agentclientprotocol/codex-acp` (+ the `@openai/codex` binary, installed as a dependency); auth from `~/.codex/auth.json`.

You only need auth for the backend(s) you actually call.

---

## Install

### From source (current)

```bash
git clone <this-repo> agentprism-workflows
cd agentprism-workflows
pnpm install      # applies the codex-acp patch + fetches backend binaries
pnpm build        # tsc -b across all packages
```

### From npm (once published)

```bash
pnpm add @automatalabs/workflows        # the SDK
# or, to run the MCP server:
pnpm add @automatalabs/mcp-server
```

---

## Packages

| Package | What it is |
|---|---|
| **`@automatalabs/workflows`** | The importable **SDK** — a thin facade to run workflow scripts programmatically with the default ACP backend. Start here. |
| **`@automatalabs/mcp-server`** | The stdio **MCP server** exposing the `workflow` tool (bin: `agentprism-workflow`). |
| **`@automatalabs/acp-agents`** | The ACP client + `Claude`/`Codex` backends (the `AgentRunner` implementation, connection pooling, structured output, permissions, usage). |
| **`@automatalabs/workflow-engine`** | The deterministic engine: the script realm, `parallel`/`pipeline`, journal/resume, budgets, worktree isolation. |
| **`@automatalabs/shared-types`** | The `AgentRunner` seam + shared types the others compose against. |

Dependency direction: `mcp-server` and `workflows` both compose `acp-agents` + `workflow-engine`, which meet only at the `AgentRunner` seam in `shared-types`. The engine never names a backend; the agents never know they're inside a workflow.

---

## Quickstart — SDK

Run a workflow script. The default backend is the ACP runner (`createAcpRunner()`), so this drives real agents and needs backend auth.

```ts
import { runDynamicWorkflow } from "@automatalabs/workflows";

const script = `
  export const meta = {
    name: "repo-scan",
    description: "describe a repo as JSON, three ways in parallel",
    phases: [{ title: "Fan" }],
  };

  const SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["repo", "fileCount"],
    properties: { repo: { type: "string" }, fileCount: { type: "number" } },
  };

  phase("Fan");
  const results = await parallel([
    () => agent("Report this repo as JSON {repo, fileCount}.", { label: "a1", schema: SCHEMA }),
    () => agent("Report this repo as JSON {repo, fileCount}.", { label: "a2", schema: SCHEMA }),
  ]);
  return results;
`;

const run = await runDynamicWorkflow(script, { args: {} });

console.log(run.status);   // "completed" | "paused" | "failed" | "aborted"
console.log(run.result);   // [{ repo: "...", fileCount: 123 }, …] — schema-validated objects
console.log(run.tokenUsage, run.runId);
```

`runDynamicWorkflow` resolves to a **terminal** `WorkflowRunResult` even on pause/fail/abort — read `run.status` instead of catching. To swap the backend (or stub it in tests), pass your own runner: `runDynamicWorkflow(script, { runner })`. For lower-level control, use `WorkflowManager` / `runWorkflow` (also re-exported from the SDK).

### Run a single agent directly

```ts
import { createAcpRunner } from "@automatalabs/workflows";

const runner = createAcpRunner();
const data = await runner.run("Summarize this repo as JSON {summary}.", {
  schema: {
    type: "object", additionalProperties: false,
    required: ["summary"], properties: { summary: { type: "string" } },
  },
  model: "opus",          // routes to Claude; e.g. "gpt-5-codex" routes to Codex
  cwd: process.cwd(),
});
// data is typed/validated against the schema (a plain object, not text)
await runner.dispose();   // closes pooled backend processes
```

---

## Quickstart — MCP server

The `workflow` tool runs a script to completion synchronously, streaming `notifications/progress`, and returns the structured result.

Register the stdio server in your MCP host's config:

```json
{
  "mcpServers": {
    "agentprism-workflow": {
      "command": "agentprism-workflow",
      "env": { "AGENTPRISM_DEFAULT_BACKEND": "claude" }
    }
  }
}
```

From source (before publishing), point at the built entry instead:

```json
{
  "mcpServers": {
    "agentprism-workflow": {
      "command": "node",
      "args": ["/abs/path/to/agentprism-workflows/packages/mcp-server/dist/index.js"]
    }
  }
}
```

**Tool: `workflow`** — input parameters:

| Param | Type | Notes |
|---|---|---|
| `script` | string (**required**) | Raw JS; first statement must be `export const meta = { name, description, phases? }`; must call `agent()` at least once. |
| `args` | any | Exposed to the script as the global `args`. |
| `maxAgents` | number | Default 1000. |
| `concurrency` | number | **Clamped** to 16 (not rejected). |
| `agentRetries` | number | **Clamped** to 3. |
| `agentTimeoutMs` | number \| null | Per-agent timeout; omit for none. |
| `tokenBudget` | number \| null | Hard total-token cap for the run; omit for none. |
| `resumeFromRunId` | string | Resume a prior run from its persisted journal (resume is **explicit**). |

The run is synchronous (one `tools/call` = one full run). Resume after a pause/crash by calling `workflow` again with `resumeFromRunId`.

---

## Writing workflow scripts

A script is plain JavaScript whose **first statement** is the `meta` literal. Inside it, these globals are available (injected into the run's realm — they are not importable functions; `@automatalabs/workflows` ships an ambient `.d.ts` so your editor knows them):

- `agent(prompt, opts?)` — run one subagent. With `opts.schema` (a JSON Schema) you get a validated object back; without it, the assistant's text. Other opts: `label`, `phase`, `model`/`tier`, `agentType`, `isolation`, `timeoutMs`, `retries`, `mcpServers`. (Working directory comes from worktree `isolation`; tool policy and instructions come from the `agentType` definition. `cwd`/`toolNames`/`instructions` are options on the lower-level `createAcpRunner().run()` API, not script-level `agent()` opts.)
- `parallel([fn, …])` — run thunks concurrently; **barrier** (awaits all).
- `pipeline(items, stage1, stage2, …)` — stream each item through stages independently (no inter-stage barrier).
- `phase(title)`, `log(msg)` — progress grouping + narration.
- `budget` — the run's token budget (`budget.total`, `budget.remaining()`, `budget.spent()`).
- `checkpoint()`, `gate()`, `verify()`, `judgePanel()`, `loopUntilDry()`, `completenessCheck()`, `retry()`, `workflow()`, `args`.

Determinism is enforced (`Date.now`/`Math.random`/`new Date()` are neutered in the realm) so a killed run **resumes** from its journal with a cache-hit on the unchanged prefix.

---

## Structured output

Pass a JSON Schema as `agent({ schema })` and the result is a **validated object**, not text. Each backend constrains generation natively (Claude via its output-format channel; Codex via a turn-level `outputSchema`), then the runner validates and re-prompts on mismatch. See [`docs/design-notes.md` §6](docs/design-notes.md) for the per-backend mechanics.

---

## Backends & selection

The backend is chosen per `agent()` call from the `model`/`tier` you pass, by provider prefix:

- `opus`, `sonnet`, `haiku`, `claude…`, `anthropic/…` → **Claude** (`claude-agent-acp`).
- `gpt…`, `codex…`, `o3`/`o4`, `openai/…` → **Codex** (`codex-acp`).
- Otherwise the default backend (`AGENTPRISM_DEFAULT_BACKEND`, default `claude`).

One long-lived ACP process per backend is **pooled** and reused across `agent()` calls (one spawn + one `initialize`), with a fresh session per call — so worktree isolation is preserved via each session's `cwd`.

---

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `AGENTPRISM_DEFAULT_BACKEND` | `claude` | Backend when the model/tier doesn't imply one (`claude` \| `codex`). |
| `AGENTPRISM_ACP_POOL_SIZE` | `1` | Long-lived processes held per backend. |
| `AGENTPRISM_CLAUDE_ACP_CMD` / `…_ARGS` | (bundled) | Override the Claude ACP server command/args. |
| `AGENTPRISM_CODEX_ACP_CMD` / `…_ARGS` / `…_BIN` | (bundled) | Override the Codex ACP server command/args/binary. |

---

## Documentation

- [`docs/design-notes.md`](docs/design-notes.md) — the deep protocol-level design: ACP lifecycle, the structured-output crux, model/permission/usage/cancellation mechanics, and the engine lineage.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — local development, testing (including the gated live-backend e2e), the Codex patch, and releasing.
- [Agent Client Protocol](https://agentclientprotocol.com) · [Model Context Protocol](https://modelcontextprotocol.io)

## License

Not yet set — a `LICENSE` file is a prerequisite before the first npm publish. See [`CONTRIBUTING.md`](CONTRIBUTING.md).
