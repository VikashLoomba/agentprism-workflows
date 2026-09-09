# MCP durable agent configuration setup

**Status:** Implemented; transport lifecycle superseded by [the asynchronous cutover](async-workflow-app-cutover.md).

## Source request

> Implement MCP elicitation before workflow execution so users can choose provider, model, and advertised configuration for each `agent()` call in one structured request. Include each call’s phase title and description. Support both legacy MCP clients advertising elicitation and modern 2026-07-28 clients using the repository’s dual-era SDK migration approach.

## Policy correction

> When using the MCP server, the agent authoring and running the workflow with the workflows tool starts the workflow with defined provider/model configuration, but for some reason the server is still sending elicitation requests. We're only supposed to be sending elicitation requests when the agent tries to use the workflows tool with a script that doesn't define some required configuration.

This supersedes the original every-call selection policy. Configuration setup fills only
unresolved effective models. Per-call, agent-definition, resolved tier, phase, and meta models count
as configured, including backend-only specs that intentionally retain the harness default model.
Mode and non-model config options are optional; omission uses backend defaults and never triggers a
configuration form. Invalid authored configuration still fails routed validation rather than opening
a form to replace it. Backend-spawn approval, checkpoints, and live ACP permissions retain their
separate interaction contracts. Canonical format-2 admission snapshots preserve the selected route
for continuation. Earlier admission formats cannot execute through MCP; the cutover has no migration shim.

## Admission order

This is an MCP composition-root policy; the workflow script DSL and the ACP runner's standalone
default routing remain unchanged.

A `run` request first reserves an active slot and durably saves its run ID, immutable script/args
snapshot, request identity, and preparation state, then acknowledges acceptance. Its project-owned
driver performs these token-free steps independently of the MCP request:

1. parse/static validation;
2. durable trust approval for script-declared backends, when required;
3. a mocked routing-discovery execution;
4. for clients advertising form or MCP Apps support, no-prompt probing of routable host and approved
   script backends when observed calls have unresolved models;
5. one durable `agent-configuration` setup request covering those unresolved occurrences;
6. an explicit `setup-response` checked against that exact stored request and catalog; and
7. a second mocked execution plus routed model/mode/config validation, followed by an atomic
   canonical admission and live dispatch.

Clients without those presentation capabilities use the host's authored/automatic routing policy.
The resulting complete effective occurrence map has strict coverage before execution. Agent-less
and fully configured workflows need no configuration setup. A preparation failure settles the
accepted run as failed; a setup decline or cancel settles it as aborted. Both remain inspectable.
No input response is invented when an MCP request ends or a client disconnects.

Automatic default selection also follows observed effective calls. Dynamic options that resolve a
model need only their routed validation probe, and unvisited agent calls do not trigger speculative
default probes. Strict occurrence coverage already rejects extra live calls before dispatch.

## Setup schema contract

MCP form schemas accept flat primitive properties, not nested per-call objects. The server therefore
uses deterministic occurrence-prefixed fields:

- one required provider/model single-select for each observed call with an unresolved model;
- one optional mode single-select per call and provider when modes are advertised; and
- optional select/boolean fields for every non-model ACP session option advertised by that provider.

Each field identifies the call ordinal and provider. Its description includes the call's resolved
label, phase title, the phase's optional `detail`, and a credential-redacted, strictly bounded task
prompt preview; the request message lists the same useful preview for every call. Provider-specific
fields are applied only when their provider is the selected route, so a
client that returns defaults for other provider groups cannot leak configuration across backends.

Provider/model values are exact routed specs. Mode, select, and boolean responses are checked against
the catalog that produced the form. The final routed preflight selects the chosen model and remains
the authority for model-specific option validation. Probe failures are omitted from choices and
reported in bounded form diagnostics. If no provider can be represented, admission fails.

## Engine and replay identity

The engine accepts host-selected configurations keyed by a zero-based occurrence ordinal shared by
the root and nested workflows. For an unresolved call, a selection supplies its model and replaces
any authored provider-specific mode and non-model config values. Replacement prevents stale
mode/option ids from leaking when the user chooses a provider and lets omission select that
provider's defaults. Calls with resolved models are absent from the form and retain all of their
authored model/mode/config values. Effective model, mode, and sorted config options enter the existing
call identity before journal lookup or runner dispatch. Call records and agent events therefore
report what actually ran.

Both authored and explicitly selected configurations populate the complete occurrence map. Strict
occurrence coverage is enabled for every MCP admission. If live control flow reaches an agent occurrence the
mocked discovery path did not observe, that occurrence fails before opening
an ACP session instead of silently using an ambient provider. Earlier observed calls may already have
run; this is the unavoidable boundary of execution-based discovery for data-dependent control flow.
That first uncovered occurrence is recorded durably; later continuation fails closed rather than
shifting an ordinal onto a different call.

At execution admission the host atomically persists a format-2 canonical effective configuration
snapshot: the occurrence map, host-pinned default model, approved script-backend map, stable
selection hash, source, and timestamp. Pending preparation stores the exact requested schema and
catalog plan. Accepted input becomes canonical configuration plus an immutable response fingerprint;
response receipts survive admission and completion. `action:"resume"` uses the same snapshot without
new routing discovery or configuration setup. Missing, invalid, old-format, or uncovered admission
cannot continue.

## Dual-era transport

The split MCP SDK v2 serves legacy 2025 sessions and modern `2026-07-28` requests through one
implementation. Both return durable asynchronous acceptance and expose unanswered setup through
`status.setup.request`. The client submits `action:"setup-response"` with the run ID, exact setup ID,
and explicit response. Neither transport returns workflow `input_required`, issues a held workflow
elicitation, or accepts workflow `requestState`/`inputResponses`.

The persisted preparation binds immutable script/args, approved backend definitions, the exact
requested schema, and the catalog plan's selection hash. A stale or malformed response fails;
identical response retries succeed even after execution, while conflicting responses fail. A live
predecessor applies answers through authenticated run control; after owner death a successor can
claim the same pending preparation and answer the same stored request.

## Tests

Credential-free coverage pins:

- flat-schema generation, phase context, bounded/redacted task previews, provider scoping, and catalog rejection;
- effective model/mode/config dispatch and call-record identity;
- atomic canonical admission, inherited same-ID continuation, and durable strict rejection of an uncovered occurrence;
- no configuration form for fully configured calls, including inherited and backend-only models;
- one request containing only unresolved calls, with configured calls preserved in mixed workflows;
- invalid authored config rejection without configuration setup or dispatch;
- equivalent legacy and modern HTTP behavior through the shared server implementation; and
- durable setup recovery, predecessor routing, and receipt-safe retries after lost responses.
