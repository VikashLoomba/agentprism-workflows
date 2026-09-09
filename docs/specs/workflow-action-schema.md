# Discriminated workflow action schema

Status: **implemented MCP contract**.

## Canonical discovery and runtime contract

The `workflow` tool publishes one draft-2020-12 `oneOf` with eight branches, in this order:
`config`, `run`, `resume`, `setup-response`, `status`, `result`, `permissions-response`, and `stop`.
Every object requires its literal `action`, lists only fields valid for that action, and sets
`additionalProperties:false`. Discovery and runtime use the same Zod union.

| Action | Required fields | Optional fields |
| --- | --- | --- |
| `config` | `action` | `projectDir`, `harnesses`, `modelSpecs`, `modelFilter` |
| `run` | `action`, `requestId`, exactly one of `script`/`scriptPath` | `projectDir`, `args`, `maxAgents`, `concurrency`, `agentRetries` |
| `resume` | `action`, `runId`, `requestId` | `maxAgents`, `concurrency`, `agentRetries`, `checkpointReplies` |
| `setup-response` | `action`, `runId`, `setupId`, `response` | none |
| `status` | `action`, `runId` | `lastN`, `labelGlob`, `logLines` |
| `result` | `action`, `runId` | `offset`, `maxBytes` |
| `permissions-response` | `action`, `runId`, `permissionId`, `response` | none |
| `stop` | `action`, `runId` | `lastN`, `labelGlob`, `logLines`, and either targeted `callIndex` or whole-run `forceOwner` |

Run has inline and path variants. Stop has whole-run and targeted-call variants. The permission
response discriminates selected and cancelled outcomes. Setup responses discriminate `accept` with
strictly validated content, `decline`, and `cancel`; the exact pending setup ID is required.
`projectDir` is required for config/run by the shared multi-project daemon and optional in a single-project server; this deployment condition
is checked after canonical validation so both protocol transports advertise the same schema.

There is no input normalizer. `action` is mandatory, the eight names above are exhaustive, and
every branch rejects unknown or cross-action fields. Runtime defaults such as result paging apply
only after an exact branch is accepted. `background`, workflow `requestState`/`inputResponses`, and
checkpoint `default`/`headless` acceptance paths are removed. Run and resume acknowledge durable
asynchronous operations; status is always an immediate snapshot. Identical retries reuse the same
`requestId`; changed arguments with that ID fail instead of creating another operation.

## Routing and discovery

Every client must supply an effective model directly or through authored routing. Missing routing
fails preparation or the actual live call with bounded discovery guidance; no agent-configuration
setup kind exists. `setup-response` remains for explicit custom-backend approval. The Config action
returns compact `authoringSummary` guidance alongside bounded catalogs; `modelSpecs` selects exact
models before option discovery and `modelFilter` expands leaf models. Aggregator `/*` entries are
browse selectors and cannot dispatch. See [explicit agent routing](explicit-agent-routing.md).

## Protocol and verification

Production registration uses the split MCP SDK v2 boundary. The stateful legacy 2025 transport and
stateless `2026-07-28` transport register the same Standard Schema and publish byte-equivalent input
JSON Schema; neither transport adds action aliases.

The committed schema snapshot pins action order, branch-local properties, required sets, structural
run/stop variants, and `additionalProperties:false`. Runtime/Ajv parity tests cover all canonical
actions and reject removed and cross-action fields.
