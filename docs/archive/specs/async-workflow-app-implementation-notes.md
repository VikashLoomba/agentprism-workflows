# Durable workflow lifecycle and App implementation

The approved scope and verbatim user request are preserved in
[async-workflow-app-cutover.md](async-workflow-app-cutover.md) and [issue #473](https://github.com/agentprism/agentprism-workflows/issues/473).
This record describes the resulting implementation; the API reference and executable schemas own
complete field definitions.

## Lifecycle and persistence

`workflow` publishes eight strict actions. Run and resume require `requestId`; the exact input
fingerprint is retained with a durable operation receipt. Acceptance never returns an execution
result, even if the work settles quickly. A lost-ack retry finds its original operation before
reading mutable script paths or consuming capacity. Conflicting input for an existing operation
fails. Accepted identities cannot be silently reconstructed from unreadable/stale backup records.

Run acceptance performs structural validation and records the immutable at-most-1-MiB UTF-8 source,
args, limits, operation identity, and pending preparation under the run lease. The project-owned
`WorkflowLifecycle` then drives backend approval, mock routing, and routed configuration validation.
No live agent runs until immutable routing admission format 3 is saved. Every actual call must resolve
a model; additional configured calls on live branches are allowed. Missing routing produces bounded
discovery diagnostics, never provider setup or automatic backend selection. See
[explicit agent routing](explicit-agent-routing.md) for the snapshot and continuation contract. Preparation format 1 is a separate
host-neutral manager envelope; the MCP driver owns its JSON payload and persisted setup schema.
`prepareRun`, `claimPreparedRun`, `updatePreparation`, `admitPreparedRun`, and `settlePreparedRun`
keep engine persistence independent of MCP transport objects.

Each workflow request is bounded to 45 seconds, including control/discovery. Each active preparation
attempt is bounded to 120 seconds; a durable human setup wait consumes no running preparation timer.
An expired attempt cannot later admit execution. Four active runs per project include preparation,
waiting setup, and execution. Receipt retries do not reserve capacity again. Request abort/progress
state is never retained by an accepted run.

Setup has `{state:"preparing"}` or `{state:"input-required",request}`. The request records its UUID,
kind (`backend-approval` only), title, message, and exact object schema. `setup-response` validates that UUID and shape,
persists canonical answers plus a response fingerprint, and acknowledges separately. Exact repeats
remain idempotent after terminal settlement. Conflicts fail. Decline/cancel/false backend approval
remain aborted runs. Invalid approval content leaves setup pending. Backend approval remains required before probing
script-declared commands; it never selects agent models.

Cold preparation recovers under the existing run lease with the same setup identity. During daemon
succession, signed control forwards setup/permission replies and cancellation to a live predecessor.
Setup receipts survive forwarding-ack loss. Dead-owner admitted execution reconciles to a durable
interrupted pause. A live lease is never stolen on timeout.

## Explicit checkpoints

All unanswered script-authored checkpoints pause. The removed fields `headless`, `default`, and
`pauseOnCheckpoint` have no runtime aliases. SDK `confirm` remains a real explicit answer channel;
absence, timeout, and invalid answers cannot become implicit approval. Confirm answers are boolean,
input answers strings including empty, and select answers exact choices. The script controls what
an explicit false answer means.

Checkpoint inputs use format 2. Journal/call/injection records carry `checkpointDecision:"explicit-v1"`.
Provenance validation runs before reply classification, writes, continuation, or reuse. Historical
automatic or ambiguous approvals and retired pending shapes refuse execution clearly. Old readable
records remain available for inspection; no guessed conversion is installed. The first explicit
answer is durable under the run lease and remains authoritative across retries and reconstruction.
Dry-run simulated answers are discovery-only and never write approval journals.

## App and host contract

Only `workflow_monitor({runId})` declares the shared static
`ui://agentprism-workflow/run-monitor.html` resource. The management tool and app-only data/notification
tools have no UI association. Exact Apps capability declarations gate discovery in both protocol
eras; the obsolete flat Apps metadata key is removed. The supported 2025 and `2026-07-28` MCP eras
remain intact through production SDK v2 transport seams.

Each invocation starts from explicit input `runId`, allowing independent App instances where the
host retains them. Reused iframes rebind deliberately, cancel old polls, and isolate late results.
Navigation is optional. Fullscreen keeps selection and run identity; narrow layouts adapt controls
and the inspector. The production App handles pending setup, live permissions, explicit checkpoint
reply/resume, whole/targeted stop, and exact-result paging/download.

The actual status wire keeps checkpoint/auth context inside `outcome`; the App projects that shape
before rendering actions. Run events remain bounded/redacted observability and are never substituted
for exact result bytes.

Selection updates bounded model context quietly. Ask explicitly sends selected-agent context.
Automatic text messages cover required input and terminal outcomes only, gated on host capability.
A project-owned claim ledger coalesces concurrent views within a host scope. Legacy scopes use the
client/session identity; modern stateless Apps use an origin-scoped UUID when available and a view
fallback otherwise. Ledger lifetime is the daemon; isolated host origins and message-accepted/ack-lost
crashes bound the deduplication guarantee. Phase and progress changes do not send chat messages.

## Verification and release surface

The implementation includes deterministic lifecycle/schema tests for both protocol eras, crash and
succession tests, explicit-checkpoint provenance/replay tests, and a production-component mock-host
browser harness covering retained/reused instances, fullscreen, setup, permissions, checkpoints,
stop, and exact results. The shipped bundle is also exercised in the official MCP Apps basic host
at `352f6ced4d80772e92b4e7a311854481a8d65b04`: independent runs, explicit checkpoint completion,
selection/context, fullscreen restoration, and exact results. Hosts decide panel retention and
message/context capabilities.

This is one breaking release train for directly changed `mcp-server`, `workflow-engine`,
`shared-types`, and `workflows`. Their old MCP execution schemas and checkpoint policies are removed
in the same change as docs, canonical authoring skills, generated content, and fixtures. SDK promise
APIs, explicit confirmation callbacks, incremental resume APIs, REPL, and both supported protocol
eras remain independent contracts.
