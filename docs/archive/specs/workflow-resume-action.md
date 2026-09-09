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
script, args, immutable routing inputs, journal, event stream, cumulative usage,
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

Before live dispatch, the host atomically persists format-3 admission:
`{ format:3, strict:true, routingSnapshot:{ modelTiers:null|{tiers}, agentDefinitions, mainModel? }, defaultModel?, scriptBackends?, routingHash, recordedAt }`.
The snapshot captures tier configuration and named-agent definitions, including their absence,
so cold continuation does not reread changed routing files. The immutable script supplies phase
and workflow models. `routingHash` binds the routing snapshot, optional host default, and approved
script backends. Continuation validates the format and integrity and reuses these inputs without
new routing discovery or provider selection.

Every actual call must resolve a nonblank effective model before identity hashing or dispatch.
Mock validation observes one path; additional configured live calls are valid, including nested
and data-dependent calls. A missing live route fails before that call reaches the runner. There is
no positional configuration map or uncovered-occurrence marker. Effective model, mode, and config
options enter call identity and durable call records (`modelRequested`, `modeRequested`, and
`configOptionsRequested`). Old or invalid admissions remain inspectable where supported but cannot
execute through MCP; start a fresh Run. Supported SDK journal eras retain their separate contracts.

## Checkpoint decisions

`checkpointReplies` keys name this run's exact `checkpointContext.callIndex`. The reply must be
strict JSON. Under the run lease, the first reply is appended to the durable journal before script
continuation or acknowledgement. Repeating that exact value is idempotent. A later different value
is reported as ignored and the first durable value remains authoritative. Cold reconstruction
replays that decision forever and never re-asks the checkpoint.

Only paused or failed continuable runs may start execution again. Missing, lease-owned,
not-continuable, and admission-missing/invalid states are tool errors naming the reason.
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
