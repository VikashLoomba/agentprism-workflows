---
"@automatalabs/shared-types": minor
"@automatalabs/acp-agents": minor
"@automatalabs/workflows": minor
---

Add Codex `baseInstructions` / `developerInstructions` session overrides to the AgentRunner seam.

`RunOptions` gains two optional, additive Codex-only fields: `baseInstructions` (replaces Codex's
built-in base system prompt for the session) and `developerInstructions` (injects developer-role
instructions on top of it). The `CodexBackend` forwards them as bare `session/new` `_meta` keys,
which the `@automatalabs/codex-acp` adapter threads into
`thread/start.{baseInstructions,developerInstructions}`. They are ignored by the Claude backend
(no analog) and are never part of the resume identity hash. Distinct from `instructions`, which is
folded into the prompt text for either backend.

Requires `@automatalabs/codex-acp` >= 1.1.0 installed for the keys to take effect end-to-end;
against older codex-acp the keys are a harmless no-op.
