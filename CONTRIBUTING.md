# Contributing

This is a **pnpm workspace** (monorepo) of five packages under the `@automatalabs` scope. The user-facing overview is in [`README.md`](README.md); the protocol-level design is in [`docs/design-notes.md`](docs/design-notes.md).

## Prerequisites

- **Node.js ≥ 22** (`.nvmrc` pins `22`).
- **pnpm 10** (`packageManager: pnpm@10.0.0`; `corepack enable` or install pnpm directly).

## Setup

```bash
pnpm install        # installs deps, applies the codex-acp patch, fetches backend binaries
pnpm build          # tsc -b across all packages (topological)
pnpm test           # pnpm build && pnpm -r test
pnpm typecheck      # pnpm -r exec tsc --noEmit
```

`pnpm install` does two non-obvious things:

1. **Applies the Codex patch.** The Codex backend needs a one-line forward of the turn-level `outputSchema` into `@agentclientprotocol/codex-acp`. It ships as a pnpm-native patch — `pnpm.patchedDependencies` in the root `package.json` → `patches/@agentclientprotocol__codex-acp@1.0.2.patch` — re-applied on every install, with no vendored source tree. See [`docs/design-notes.md` §6.3](docs/design-notes.md).
2. **Fetches native binaries.** Both backends pull an os/cpu-gated native binary (`@openai/codex`, `@anthropic-ai/claude-agent-sdk`). Stay on a glibc x64 runner in CI and do **not** pass `--no-optional`.

## Package layout

| Package | Role |
|---|---|
| `packages/shared-types` | The `AgentRunner` seam + shared types. |
| `packages/workflow-engine` | The deterministic engine (realm, parallel/pipeline, journal/resume, budget, worktree). |
| `packages/acp-agents` | ACP client + Claude/Codex backends (the `AgentRunner` implementation, pooling). |
| `packages/mcp-server` | The stdio MCP server / composition root (bin `agentprism-workflow`). |
| `packages/workflows` | The importable SDK facade. |

`workflow-engine` and `acp-agents` are **siblings** — neither imports the other; they meet only at the `AgentRunner` seam in `shared-types`. `mcp-server` and `workflows` are the two composition roots that wire them together.

### Conventions

- TypeScript source resolution in-repo: each package's `exports.types` points at `./src/index.ts` for the dev build; the published manifest is overridden to `./dist` via `publishConfig` (see below). Don't repoint the top-level fields to `dist`.
- Tests use `node:test` via `tsx` (`tsx --test`). Keep the default suite deterministic and credential-free.
- The `agentprism/*` protocol `_meta` keys, the `AGENTPRISM_*` env vars, the `.agentprism/` runtime dirs, and the `agentprism-workflow` bin are a **wire/CLI contract** — they are intentionally *not* renamed with the npm scope.

## Testing

`pnpm test` runs the full suite; everything except one file uses in-memory/fake ACP agents, so no credentials are needed.

The one exception is the **live-backend e2e** (`packages/mcp-server/test/live-backend.e2e.test.ts`), which drives the real Claude + Codex backends end-to-end. It is **skipped by default** and only runs when you opt in with real auth:

```bash
AGENTPRISM_LIVE_E2E=1 pnpm --filter @automatalabs/mcp-server test
```

CI must leave `AGENTPRISM_LIVE_E2E` unset.

## Releasing

Versioning is managed with **[Changesets](https://github.com/changesets/changesets)**.

```bash
pnpm changeset        # describe your change + pick bump levels
pnpm version          # changeset version — applies bumps + changelogs (usually via the release PR)
pnpm release          # pnpm build && changeset publish (CI only)
```

Publishing is wired in `.github/workflows/release.yml`, but it is **dormant** (manual `workflow_dispatch` only) until two prerequisites are met:

1. **npm auth** — OIDC trusted publishing is configured for the `@automatalabs` org (no long-lived token needed).
2. **The `@automatalabs/codex-acp` fork is published** — the pnpm patch above does **not** travel to npm consumers, so until a patched Codex package is published and `acp-agents` depends on it, a published build's Codex structured output would silently degrade.

Until then, merging to `main` never auto-publishes. A `LICENSE` file is also required before the first publish.

CI (`.github/workflows/ci.yml`) runs on every PR and push: frozen install → `tsc -b` → `tsc --noEmit` → `pnpm -r test` on Node 22 / pnpm 10.
