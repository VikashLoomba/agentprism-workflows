# ACP+MCP orchestrator — build runbook

Phased, human-gated build of the Pi-independent ACP+MCP workflow orchestrator described in `../README.md`.
Each phase is a saved Workflow under `../.claude/workflows/`. Run them **in order**, and **read each phase's
handoff JSON before launching the next** — the gate is deliberate.

## Phases

| Phase | Workflow name | Reads | Writes (handoff) |
|---|---|---|---|
| 0 · ground truth | *(done)* | pinned source | `ground-truth.json` (+ `corrections` overlay) |
| 1 · freeze + scaffold | `acp-build-phase1-freeze` | `ground-truth.json`, `../README.md` | `phase1-contract.json`, scaffold commit |
| 2 · implement | `acp-build-phase2-implement` | `phase1-contract.json`, staged source | `phase2-modules.json`, 3 branches |
| 3 · integrate | `acp-build-phase3-integrate` | `phase2-modules.json` | `phase3-integration.json`, merge commit |
| 4 · verify | `acp-build-phase4-verify` | `phase3-integration.json` | `phase4-verify.json` |

`ground-truth.json` is the authoritative Phase-0 input — its top-level **`corrections`** block WINS over
`findings`/`readiness` on any conflict (Codex structured-output is verified end-to-end; all README citation
discrepancies are fixed; MCP bounds clamp-not-reject).

## Run a phase

By name (resolves from `.claude/workflows/`):

    Workflow({ name: "acp-build-phase1-freeze" })

…or by path:

    Workflow({ scriptPath: "<repo>/.claude/workflows/acp-build-phase1-freeze.js" })

Each returns a `runId`. To resume after a pause/edit:
`Workflow({ scriptPath: "…", resumeFromRunId: "<runId>" })` (completed agents return cached results).

## Prerequisites

- `node` (v24 used), `pnpm`, `git`, `npm`.
- **Staged source** (Phase 2 reads it): run `./stage-sources.sh` to (re)create `./sources` + `./sdks`.
  Already present in this checkout; re-run only if missing or in a fresh session.
- **Pi engine source** at `/home/vikash/pi-dynamic-workflows/src` @ `1b0291ab` (lifted by Phase 2).
- **Phase 4 smoke** needs real backends: `claude-agent-acp` (Anthropic auth) and the patched
  `codex-acp` (OpenAI/Codex auth). If a backend can't auth here, Phase 4 reports it rather than passing.

## How worktrees are used + integrated (Phase 2 → 3)

The parallel module work is isolated with **self-managed git worktrees**, not the harness `isolation` flag,
so the merge contract is concrete:

1. **Phase 2 · Prepare** creates three worktrees OUTSIDE the repo at `/home/vikash/agentprism-worktrees/<module>`,
   each on branch `phase2/<module>` cut from the **exact scaffold commit** (`phase1-contract.json.scaffoldCommitSha`).
   They share the main repo's object store + refs, so the branches are visible/mergeable from the main repo.
2. **Phase 2 · Implement** runs the three module agents concurrently, each confined to its own worktree and to
   `packages/<module>/` only. Hard rule: **never commit root files or `pnpm-lock.yaml`** (each module adds deps to
   its own `package.json`; the lockfile is regenerated once in Phase 3). This is what keeps the three branches
   conflict-free.
3. **Phase 3 · Integrate** merges **by commit SHA** (`git merge --no-ff <sha>`) — robust to branch-name quirks —
   then runs a **single `pnpm install`** to reconcile the lockfile, builds, and loops fix→rebuild until green. A
   merge conflict here is a signal that a module escaped its package dir → it stops rather than force-resolving.
   On success it removes the worktrees (branches remain in history).

Note: the *engine's own* `worktree.ts` (the product feature that isolates subagents at runtime) is a separate
thing — it's lifted in Phase 2 and exercised in Phase 4, unrelated to how we build the system.

## State / cleanup

- Handoffs (`phase*.json`) + `ground-truth.json` are the durable chain; safe to inspect/diff between phases.
- `sources/`, `sdks/`, `worktrees/` are gitignored (re-creatable).
- To restart a phase clean: delete its handoff JSON and the branches/worktrees it created, then re-run.
