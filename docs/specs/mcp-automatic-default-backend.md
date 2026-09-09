# MCP automatic default backend selection

**Status:** Implemented

## Source request

> In practice, users never set AGENTPRISM_DEFAULT_BACKEND, so claude always gets selected when their agent that calls the workflows tool omits a selection in agent calls. I think we should be choosing a default backend in the MCP server intelligently by probing available backends first. But my question to you is if our probeHarnessConfig function accounts for authentication status. If it does then we should choose the first available backend, if not we'll need to discuss what to do
>
> Got it. Lets go with your recommendation.

## Scope

This is an MCP composition-root policy. The SDK runner's routing contract remains unchanged: an
omitted model still uses `AGENTPRISM_DEFAULT_BACKEND`, whose historical fallback is Claude.
For MCP clients that advertise form or MCP Apps support, the workflow tool fills unresolved models on
dry-run-observed `agent()` occurrences with one durable setup request (see the MCP server
API contract). Authored effective models, including inherited and backend-only specs, are preserved;
optional mode/config omissions never trigger that form. Automatic selection is the host policy only when all of these
are true:

1. the connected client advertises neither form nor MCP Apps support;
2. a mock routing-discovery pass reaches a call with neither an effective model nor a tier;
3. `AGENTPRISM_DEFAULT_BACKEND` is truly absent from the daemon environment; and
4. the injected runner exposes backend listing, default identity, and no-prompt config probing.

For a client using automatic routing, an explicitly present environment value always wins, including the historical empty/unknown value
behavior. Agent-less workflows and workflows whose observed calls already resolve their models
(including inherited models and dynamically assembled options) do not run automatic discovery.

This supersedes the earlier conservative static trigger for unvisited branches and dynamic options.
Every MCP admission now persists a complete occurrence configuration map and requires strict coverage:
an extra live occurrence fails before dispatch, so selecting a fallback for it serves no purpose.
Discovery follows the mock execution's effective calls. The public SDK
`workflowMayUseDefaultModel()` analysis helper remains available to embedding hosts; MCP no longer
uses it to trigger default selection. Current format-2 admission snapshots remain valid for same-ID
continuation; earlier admission formats require a fresh MCP run. The SDK runner's default routing is unchanged.

## Readiness semantics

`probeHarnessConfig()` opens `session/new`, optionally selects a model, reads configuration, and
closes the session without prompting. A failed spawn/session/auth/model-selection request is
`probed:false`, but `probed:true` is not a universal authentication proof because ACP backends may
defer credential validation until `session/prompt` and ambient CLI credentials are invisible to the
runner's auth bookkeeping.

Automatic selection therefore uses three internal states:

- **ready**: the no-prompt probe succeeded and the built-in exposes stronger evidence available at
  session-open time. Codex checks authorization during session creation. Pi's model catalog is
  credential-filtered and must contain a current or selectable model.
- **unknown**: the session/config probe succeeded, but zero-token prompt readiness is not universally
  observable (Claude, OpenCode, and custom backends).
- **unavailable**: the probe failed, or a built-in explicitly advertised neither a current nor a
  selectable model.

Candidates retain registry order. Selection takes the first `ready` candidate, then the first
`unknown` candidate. Discovery runs after durable asynchronous acceptance. If all candidates are
unavailable, the accepted run settles as failed with bounded per-backend diagnostics and no live
dispatch. Successful discovery is cached per project for the daemon lifetime; failures are not cached, so an out-of-band install/login can make the next run
succeed.

## Determinism and continuation

The selected backend name is injected as the engine's host-pinned `defaultModel` before full
validation and execution. It applies after explicit model, agent-definition model, tier, and
phase/meta routing. Consequently it is passed to the runner as a backend-only model spec and enters
the existing model field of the agent identity hash.

The resolved pin and full occurrence configuration are persisted atomically in the run's
format-2 canonical admission snapshot. Nested workflows share the occurrence space. Same-ID MCP continuation
inherits that exact host-owned snapshot without probing, reopening configuration setup, recovering, or guessing a new
provider. A pre-contract run without valid admission metadata remains inspectable but must start a
fresh Run. The backend never changes mid-run: a later `AUTH_REQUIRED` follows the normal resumable
pause path rather than silently sending the prompt to another provider.

## Tests

Credential-free coverage pins:

- readiness classification, custom shadows, empty built-in catalogs, and failure diagnostics;
- positive-evidence preference and unknown fallback;
- per-project discovery caching;
- explicit environment precedence;
- no discovery for resolved models, including dynamic options, or unvisited agent calls;
- strict rejection before dispatch for extra live occurrences without speculative default discovery;
- persistence and call-identity inclusion of `defaultModel`; and
- exact canonical selection inheritance on same-ID MCP continuation.
