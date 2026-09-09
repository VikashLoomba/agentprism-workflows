# Explicit agent routing and configuration discovery

Implementation design approved by the user on 2026-09-08.

## Source request

> AgentPrism MCP app elicitation needs a look over/review. Been having issues with it to the point that I’m considering requiring agent calls to be configured
>
> Gotcha. That makes sense. For the actionable configuration error, can we use ACP to probe available backends for configOptions, which should have a response like
>
> to show what's available for each backend?
>
> Okay claude and codex seem very straightforward because they by default have small catalogs. For opencode and pi, it would be nice to send a limited list, but the list should actually represent their configured providers/models. Is that possible?
>
> Okay then lets use enabledModels for pi at least. For opencode instead of trying to overcomplicate it, lets show configured providers other than aggregators at the top and for the aggregators likee opencode we show a single option like `openrouter/*`. Hwos that
>
> Makes sense. I think we've hashed out the implementation details, so lets get this implemented now.

## Approved behavior

MCP workflow execution requires every actual agent call to resolve a model route from the call, agent definition, resolved tier, phase, or workflow default. Backend-only routes such as `codex` intentionally select that backend's configured default model. Mode and effort remain optional. Missing routing produces an actionable configuration error enriched with bounded live ACP discovery. No implicit agent-configuration setup form and no ambient backend auto-selection remain in MCP workflow execution. Explicit config discovery remains available. Custom-backend approval, checkpoints, live permissions, and both supported MCP protocol eras retain their contracts.

Mock validation observes one path and cannot prove coverage. The actual resolved call inputs are authoritative before dispatch and identity hashing; a global mock ordinal must never override them. Additional fully configured live calls are valid. Missing live configuration fails before calling the runner. Effective model, mode, and config options participate in actual call identity and durable continuation records. Continuation reuses immutable routing inputs and verifies the current admission format; old positional admissions remain inspectable but cannot execute. No compatibility parser or positional map is retained.

Admission moves from format 2 (positional selected configurations) to format 3 (authored routing, `strict: true`, immutable routing inputs, integrity hash and timestamp). The engine retains the public `requireAgentConfiguration` switch, now checking actual effective routing. The obsolete `WorkflowAgentConfiguration`, `agentConfigurations`, canonicalizer, selection source, and uncovered-occurrence map contract are removed. The SDK's non-strict default remains outside this MCP change. Explicit runtime configuration is journaled per actual call.

## Discovery

Probe backends concurrently with cancellation and finite per-probe bounds, retaining healthy catalogs when other backends fail. Exact-model probes remain the authority for model-specific options; no default-model option catalog claims to apply to every model. Missing-route errors include the failing call label and phase, explicit examples, partial-discovery failures, and instructions for exact-model discovery.

Claude and Codex show their small live catalogs. Pi keeps the complete supported ACP model catalog, and adds preference metadata on its model config option under `_meta["@automatalabs/agentprism.modelDiscovery"]`: `{ source: "enabledModels", preferred: string[], unmatched: string[] }`. Preferences come from merged native Pi `enabledModels` settings, preserving pattern order and native matching semantics, intersected with available authenticated models. Unmatched patterns are reported; this is a presentation shortlist, not an execution allowlist. When no preference list is configured, discovery describes the available provider groups honestly.

OpenCode discovery groups the live catalog by exact provider prefix. Direct-provider configured models appear first. Explicitly classified aggregator providers appear as browse entries such as `openrouter/*` and `opencode/*`, with counts. They are discovery selectors, never executable routes. Full leaf expansion remains available through the existing config `modelFilter` substring/regex API, for example `harnesses: ["opencode"], modelFilter: "/^openrouter\\//"`. Execution requires an exact route such as `opencode/openrouter/openai/gpt-5.6-sol`.

## Validation and release

Cover divergent mock/live branches, reversed completion order, additional configured calls, missing calls on unseen branches, backend-only defaults, resolved routing sources, continuation without discovery/default drift, old admission refusal, model-specific option validation, partial probe failures, Pi native pattern matching and unmatched entries, OpenCode direct/aggregator grouping, and wildcard dispatch rejection. Update the affected contract documents, canonical authoring docs and generated bundle, and direct-package Changesets. Run package-focused checks followed by the full repository gates and release workflow.

## Durable admission and call records

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
continue or seed execution; start a fresh configured run. Supported SDK journal eras retain their separate contracts.

The optional `onMissingAgentConfiguration({ label, phase? })` callback returns diagnostic text only.
It cannot supply or replace a route; failure of discovery never hides the missing-route error.

## Probe bounds and presentation

Probes run concurrently with independent cancellation deadlines. `probeTimeoutMs` defaults to
60,000 ms and must be a positive timer-safe integer; `probeConcurrency` defaults to 4 and accepts
1–16. Results retain request order and healthy catalogs when another backend fails. An optional
`signal` shares cancellation across probes, retaining completed catalogs and skipping queued targets.
MCP missing-route diagnostics use a 5,000 ms per-probe bound and concurrency 4. Explicit MCP config requests allow 15,000 ms per probe with a shared 40,000 ms discovery budget inside the 45,000 ms request deadline. Completed catalogs survive cancellation; active probes are aborted and queued targets receive timeout entries without starting. Exact-model fallback probes share the same budget. Discovery cannot select a route.

`authoringSummary` adds bounded guidance alongside the complete supported programmatic catalog.
The current model is shown separately as `currentModel`, with `currentRoute` only when it is an
advertised executable leaf; it need not belong to a preference shortlist. `omittedCurrentModel`
reports a value excluded by presentation bounds. Claude and Codex show their small live model
catalogs. Pi's native merged `enabledModels` patterns
produce an ordered preference shortlist intersected with authenticated available models, with
unmatched patterns reported. This is presentation only, never an execution allowlist. Without a
preference list, Pi shows available provider groups. OpenCode shows configured direct-provider models
first, representing each direct provider before filling additional rows when the list is bounded.
Exact provider IDs `openrouter`, `opencode`, `opencode-go`, `huggingface`, `amazon-bedrock`, and
`github-copilot` are classified as aggregators, with browse selectors such as `openrouter/*` and counts. Omitted entries carry counts and expansion guidance.
Browse selectors are not executable models. Expand the full leaf catalog with `modelFilter`
(case-insensitive substring or slash-delimited regex), for example:

```json
{ "action":"config", "harnesses":["opencode"], "modelFilter":"/^openrouter\\//" }
```

Use an exact route such as `opencode/openrouter/openai/gpt-5.6-sol` for execution. Leaf IDs stay
verbatim; do not shorten provider prefixes or infer models from display names. Backend-only probes
report options for the default model only. Probe `modelSpecs:["codex/gpt-5.6-sol"]` (or another exact
returned route) before choosing model-specific mode, effort, or `configOptions`.
