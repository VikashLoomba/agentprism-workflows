---
"@automatalabs/shared-types": minor
"@automatalabs/acp-agents": minor
"@automatalabs/workflows": minor
---

Drop the `agentprism/` prefix from the ACP `_meta` keys — use bare, standard names.

`META_KEYS.outputSchema` is now `"outputSchema"` (was `"agentprism/outputSchema"`) and
`META_KEYS.runId` is now `"runId"` (was `"agentprism/runId"`), mirroring the target Codex param
names and the bare-key convention already used by `baseInstructions` / `developerInstructions` /
upstream `additionalRoots`. The now-unused `META_NS` export is removed.

BREAKING (wire): the Codex schema forward rides `_meta.outputSchema` and the run-correlation
stamp rides `_meta.runId`. `@automatalabs/acp-agents` bumps its `@automatalabs/codex-acp` dependency
to `1.2.0`, which reads the bare `_meta.outputSchema` key — the exact pin keeps the pair in sync.
Removed `META_NS` from the public API of `@automatalabs/shared-types`.
