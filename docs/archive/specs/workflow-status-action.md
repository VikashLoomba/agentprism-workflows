# Canonical workflow status action

Status: **implemented MCP contract**.

## Scope

The model-facing observation action is an immediate point-in-time read:

```ts
interface WorkflowStatusToolInput extends WorkflowRunInspectionOptions {
  action: "status";
  runId: string;
}
```

`lastN`, `labelGlob`, and `logLines` retain their validation, filtering, redaction, and projection
bounds. Status never waits or emits polling metadata. Callers that need a
later snapshot issue another status request; a status request never cancels, pauses, resumes, or
otherwise changes workflow execution.

A successful response contains the bounded `WorkflowRunStatus`, cumulative token usage, current
safe permission projection, durable preparation/setup request, terminal `outcome` when settled,
script/result/events resource links, compact `latestActivity`, and immutable script identity. The detailed event resource remains the
durable cursor source; lower-level SDK ancestry is not projected through MCP.

## Permission observation and collection

Status exposes an already-sanitized public permission projection but never opens an elicitation
form. The projection names run ID, phase, agent label, backend, tool title, and tool kind. It
includes a credential-redacted, strictly bounded rendering of available `rawInput`, `content`, and
`locations`, so commands and file targets are visible. It also explains the exact scope of every
ordered advertised option: one request or the remainder of that agent session, allow or reject.
Private ACP session IDs and unredacted secrets never enter the projection. If the safe projection
cannot retain the complete option set, it fails closed instead of presenting an ambiguous choice.

All workflow runs use the same bounded observation and response actions. Run and resume return a
durable acceptance; status exposes pending permissions and the App or another caller answers
through `permissions-response` with one exact advertised option ID or cancellation. No run, resume,
or status request owns a permission or checkpoint form. Setup questions appear at `setup.request`
and use `setup-response`; paused checkpoints appear at `outcome.checkpointContext` and use an
explicit later resume with `checkpointReplies`.

A successor resolves live permission state through the predecessor's control endpoint before it
reads the status snapshot. This prevents a completion during that awaited query from combining a
nonterminal status with a completed result link. Only completed runs advertise `resultUri`.

## Protocol and verification

Legacy 2025 sessions and modern `2026-07-28` requests use the same acceptance, observation, and
explicit response contract. Tests cover immediate observation, absence of workflow elicitation,
setup and permission responses, terminal outcomes, unknown runs, redaction and byte bounds,
visible commands/file targets, exact option ordering/scope, private-session exclusion, coherent
successor observations, and both protocol eras.
