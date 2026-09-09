# Canonical workflow resume action

Status: **implemented MCP contract**.

## Scope

The model-facing `workflow` tool continues one already-admitted run in place:

```ts
interface WorkflowResumeToolInput {
  action: "resume";
  runId: string;
  requestId: string;
  maxAgents?: number;
  concurrency?: number;
  agentRetries?: number;
  checkpointReplies?: Record<number, unknown>;
}
```

`runId` is both the input and output run identity. Resume never allocates a child run, exposes an
attempt identity, accepts new script content, or accepts replacement args. It reloads the persisted
script, args, canonical host-owned agent configuration, journal, event stream, cumulative usage,
checkpoint decisions, and eligible interrupted ACP session state. The same event stream continues
from its durable cursor and provider usage is added to the run's existing total.

`maxAgents`, `concurrency`, and `agentRetries` are runtime controls for the continuing execution;
they do not change logical inputs or agent routing. Every accepted resume returns after the
continuation and its operation receipt are durably admitted under the same run lease. It includes
`accepted:true`, `requestId`, `duplicate`, and the canonical `continuation` receipt. Execution
continues independently of the MCP request; callers inspect `status` or read `result` after completion.

`requestId` identifies one resume operation. An identical retry returns the original acceptance and
continuation generation even if execution has since reached another checkpoint or completed. Reusing
that ID with changed arguments fails. A deliberate later continuation uses a fresh request ID.
The continuation receipt and any first checkpoint answer commit together before acknowledgement.

The MCP schema accepts no replacement script, arguments, provider selection, or source-run
selector. The Run action accepts explicit new content only and cannot name a prior run.

## Canonical admission

Before the first live call, the host atomically persists a format-2 admission snapshot containing
the canonical effective occurrence-indexed model/mode/config selection, host-pinned default model,
approved script backend map, selection hash, source, and admission timestamp. The canonical admission
contains effective configuration rather than raw form responses; pending setup separately stores its
exact schema/catalog and immutable response receipts. A continued run uses that snapshot without probing or opening new configuration setup.

Strict occurrence coverage remains active for the life of the run. If execution reaches an agent
occurrence that admission did not cover, the occurrence is durably recorded and the run fails
closed. Every later resume refuses with `admission-uncovered`. A pre-contract run with no valid
admission snapshot remains observable when its stored data permits, but MCP continuation refuses
with a named admission error and instructs the caller to start a fresh Run. There is no migration,
mapping guess, or fallback selection.

## Checkpoint decisions

`checkpointReplies` keys name this run's exact `checkpointContext.callIndex`. The reply must be
strict JSON. Under the run lease, the first reply is appended to the durable journal before script
continuation or acknowledgement. Repeating that exact value is idempotent. A later different value
is reported as ignored and the first durable value remains authoritative. Cold reconstruction
replays that decision forever and never re-asks the checkpoint.

Only paused or failed continuable runs may start execution again. Missing, lease-owned,
not-continuable, and admission-missing/invalid/uncovered states are tool errors naming the reason.
Running, terminal, auth-blocked, and unanswered-checkpoint states are not errors: the response is
the run's current observation (the same shape as `status`, including the pending `authContext` or
`checkpointContext` and any reported checkpoint resolutions) with guidance on what to do next.
Completed and aborted runs are terminal.

Only a newly accepted answer for the pending checkpoint moves the run past that pause. An
idempotent repeat or ignored conflict for an already-journaled checkpoint never substitutes for the
answer to a later checkpoint. `checkpoint()` accepts no `default` or `headless` option; `timeoutMs`
is advisory and never creates a decision. A missing, declined, cancelled, or invalid answer leaves
its checkpoint unanswered. The MCP request never opens an elicitation or remains pending for input.
The App or another caller submits an explicit later `resume` with `checkpointReplies`.

Every reusable checkpoint journal entry, successful call record, and retained injection records
`checkpointDecision:"explicit-v1"`. Continuation rejects historical automatic decisions, missing or
unsupported decision provenance, and pending checkpoints with retired answer policies before reuse
or reply classification. Such artifacts remain inspectable but require a fresh Run for execution.

## Protocol and verification

The stateful legacy 2025 transport and stateless `2026-07-28` transport expose this identical
lifecycle through one implementation. Both acknowledge bounded operations and use the same durable
`setup-response`, `permissions-response`, and `resume` with `checkpointReplies`. Workflow `requestState` and
`inputResponses` are rejected; no transport-specific input loop is retained.

Focused coverage pins stable run IDs, immutable script/args/config, cumulative usage, exact journal
prefix replay, cold continuation, admission failures, lease races, first-answer checkpoint
durability, explicit-decision provenance, idempotent operation retries across later generations,
ignored checkpoint conflicts, and both protocol eras.
