# @automatalabs/mcp-server

## 0.2.0

### Minor Changes

- 3395bbf: Custom ACP backends + generic `_meta` passthrough — run **any** ACP agent as an `agent()` target, not just the built-in Claude/Codex pair.

  - **Backend registry**: register named ACP backends via `createAcpRunner({ backends: { name: { command, args?, env?, sessionMeta? } } })` or the `AGENTPRISM_BACKENDS` env var (JSON, same shape; the programmatic option wins per name; `claude`/`codex` reserved). Registered names route `model`/`tier` specs **before** the built-in heuristics: `model: "browser"` routes to the backend; `model: "browser/vision-large"` additionally selects `vision-large` from the agent's config-option catalog. `AGENTPRISM_DEFAULT_BACKEND` may name a registered backend. Custom backends speak the published generic dialect: a `schema` is forwarded as turn-level `_meta.outputSchema` (plain JSON Schema) and the result is JSON-parsed off the final assistant message, with the client-side validate/re-prompt ladder as the repair path.
  - **Generic `_meta` passthrough**: `RunOptions.meta` / `RunOptions.promptMeta` (script-level `agent(p, { meta, promptMeta })`) merge into the outgoing ACP `session/new` / `session/prompt` `_meta`, so workflows can drive any ACP agent's custom extension surface. Precedence: a custom backend's static `sessionMeta` defaults < per-call `meta` < backend protocol-critical keys (schema channels, Codex instruction forwards) < the engine `runId` stamp. Both fields are additive run inputs and never enter the resume identity hash — resume keys stay stable across meta changes.

### Patch Changes

- Updated dependencies [3395bbf]
  - @automatalabs/shared-types@0.4.0
  - @automatalabs/workflows@0.5.0

## 0.1.6

### Patch Changes

- 087e566: Docs-only: refresh package READMEs so npmjs.org reflects the current state — drop stale
  "pre-release / install from source" framing (the packages are published), and complete the
  `RunOptions` field lists (`baseInstructions` / `developerInstructions` on shared-types, `runId`
  on acp-agents). No code or API changes.
- Updated dependencies [087e566]
  - @automatalabs/shared-types@0.3.1
  - @automatalabs/workflows@0.4.1

## 0.1.5

### Patch Changes

- Updated dependencies [f2948b3]
  - @automatalabs/shared-types@0.3.0
  - @automatalabs/workflows@0.4.0

## 0.1.4

### Patch Changes

- Updated dependencies [93e4906]
  - @automatalabs/shared-types@0.2.0
  - @automatalabs/workflows@0.3.0

## 0.1.3

### Patch Changes

- Updated dependencies [548815f]
  - @automatalabs/workflows@0.2.0

## 0.1.2

### Patch Changes

- f65e7a7: Per-package READMEs; mcp-server now consumes the @automatalabs/workflows SDK.
- Updated dependencies [f65e7a7]
  - @automatalabs/shared-types@0.1.2
  - @automatalabs/workflows@0.1.2

## 0.1.1

### Patch Changes

- b8303f6: Validate the OIDC trusted-publishing release pipeline (no functional changes).
- Updated dependencies [b8303f6]
  - @automatalabs/shared-types@0.1.1
  - @automatalabs/workflow-engine@0.1.1
  - @automatalabs/acp-agents@0.1.1
