## Choosing the agent for each call

**Context:** JavaScript passed to the MCP `workflow` tool. Workflow scripts use `agent(prompt, options?)`; REPL evals use a different API.

The backend is selected **per `agent()` call** from its effective `model` string. One script can plan on one vendor's agent, implement on another's, and review on a third's, handing structured results between them.

The built-in names (`claude`, `codex`, `opencode`, `pi`) come from the runtime backend registry. Registered custom names extend that set.

- **Configure every actual call.** A call may inherit its model from a named-agent definition, resolved tier, phase, or `meta.model`; otherwise supply `model` explicitly. This applies to every MCP client. Missing routing fails before runner dispatch with a label/phase diagnostic and bounded live discovery. No agent-configuration form or automatic default selection exists. The non-strict SDK runner retains its configured default (`AGENTPRISM_DEFAULT_BACKEND`, historical fallback Claude).
- **Route by one registered first segment.** Split on the first `/`; ASCII-case-insensitive `claude`, `codex`, `opencode`, `pi`, or a registered custom backend name selects that harness and is stripped exactly once. A custom registration wins on a built-in-name collision.
- **Use a backend name alone** (`claude`, `codex`, `opencode`, `pi`, or a custom name) to preserve the harness's configured default model. No model config call is made.
- **Everything else goes intact to the default backend.** `anthropic/…`, `openai/…`, bare `opus`, and bare `gpt-…` are not routing aliases. When an id remains after routing, it is sent byte-for-byte: no catalog matching, case folding, bracket parsing, effort/Fast option driving, retry, or fallback. Harness rejection is an agent error.
- **`tier`** (`"small" | "medium" | "big"`) must resolve through the captured tier config or host `mainModel`. A tier suppresses phase/meta/default routing; an unresolved tier cannot dispatch in MCP.

Mock validation observes one path. Additional configured live calls are valid; a missing model on
an unseen branch still fails before that call reaches ACP. Admission captures immutable tier and
named-agent routing inputs in format 3, with an integrity hash and approved backend definitions.
Continuation uses the snapshot without new selection or routing-file drift. Old admissions are
inspectable but cannot execute. Backend-approval setup, checkpoints, and live permissions retain
their separate contracts in both MCP eras.

The published examples use ids verified against live harness catalogs: `claude/opus[1m]`, `codex/gpt-5.6-sol`, and `opencode/zai/glm-5.2`. For Pi, `pi/openrouter/vendor/model-id` strips only `pi/`; Pi then splits provider `openrouter` from model id `vendor/model-id`. Prefer backend-only forms when the desired model is configured inside the harness.

Never guess model ids, mode ids, effort values, or option names from memory. With MCP, call the `workflow` tool using `action:"config"` and optional `harnesses` / `modelSpecs` / `modelFilter`; it returns the live catalog without starting a workflow.

One no-prompt session per harness, zero tokens: each successful harness entry contains `modes`, `defaultModeId`, and its config-option catalog. A non-null `modes` object carries every available mode's raw id, name, description, and `_meta`; only exact advertised ids are valid. Omission applies Claude `auto`, Codex `agent`, OpenCode `build`, or no Pi mode. For trusted implementation/review work, explicitly choose Claude `bypassPermissions` or Codex `agent` when the catalog advertises it. Claude `auto` delegates permission policy to a model classifier and may ask the user; it is not fully autonomous. `modes:null` means the backend supports no mode. `probed:true` proves session/config discovery, not universal first-prompt authentication. The bare config probe reads the default model; option domains are model-specific, so use `modelSpecs` for the selected model and confirm every pinned value against its own echoed entry.

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

```js
const plan   = await agent(PLAN_PROMPT,          { label: "plan",      model: "opencode/zai/glm-5.2", schema: PLAN });
const impl   = await agent(implPrompt(plan),     { label: "implement", model: "codex/gpt-5.6-sol", mode: "agent" });
const review = await agent(reviewPrompt(impl),   { label: "review",    model: "claude/opus[1m]", mode: "bypassPermissions", schema: REVIEW });
```

Use `configOptions` only for exact ACP session options advertised by that routed harness. With MCP, read the selected harness's `action:"config"` result before choosing ids or select values; catalogs vary by harness version, login, and machine.

```js
const impl = await agent(implPrompt(plan), {
  label: "implement",
  model: "codex",
  mode: "agent",
  configOptions: { "fast-mode": true, reasoning_effort: "high" },
});
```

Ids and string/boolean values pass through verbatim in ascending id order, after model selection and before the prompt. There are no aliases, coercion, client-side vocabulary, defaults, or cached catalogs. Copy option ids character-for-character from the catalog, punctuation included — `"fast-mode"`, not `fast_mode` — and quote ids that are not valid identifiers. Never put `"model"` in `configOptions`; use the dedicated `model` field. A harness rejection follows the ordinary agent-error path.

Pi's thought-level option is named `thinkingLevel`, and its choices depend on the exact model in the same call:

```js
const review = await agent(REVIEW_PROMPT, {
  label: "pi-review",
  model: "pi/openrouter/vendor/model-id",
  configOptions: { thinkingLevel: "high" },
});
```

Validation selects `openrouter/vendor/model-id` before reading Pi's choices. A listed value passes unchanged. A recognized value above an ordered model's ceiling, or in a model-specific gap, passes with a warning that names the effective clamp target. Pi advertises its SDK-derived domain directly. Claude and Codex are also ordered: when their options omit domain metadata, validation enumerates the advertised models and merges their per-model effort orders. A Claude model without an `effort` option does not support effort, and `default` never becomes a ceiling target. OpenCode and custom backends have no declared value order, so validation is exact-set. An unrecognized or unadvertised value fails with exit code `2`. Enumeration stops at 32 advertised models; a larger or inconsistently ordered catalog warns and falls back to exact advertised-value validation.

**The harness is authoritative.** The client never substitutes a nearby model or silently falls back. A rejected id follows the existing agent-error path; a harness that accepts or ignores it determines the outcome. The public `fallbacks`/`onModelFallback` fields remain for compatibility but model resolution does not emit them.

## Structured output

Pass `schema` — a **plain JSON Schema object literal** (no schema builders exist inside the realm) — and the call resolves to a **validated object** instead of text:

```js
const FINDINGS = {
  type: "object",
  additionalProperties: false,
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["file", "line", "summary"],
        properties: {
          file:    { type: "string", description: "Repo-relative path — copy it exactly, never invent one" },
          line:    { type: "number", description: "1-indexed line the finding anchors to" },
          summary: { type: "string", description: "One sentence stating the defect, grounded in code you actually read" },
        },
      },
    },
  },
};

const report = await agent("Review the diff on this branch for correctness bugs.", {
  label: "review", model: "codex", schema: FINDINGS,
});
report.findings.forEach((f) => log(`${f.file}:${f.line} ${f.summary}`));
```

The same schema works on **every** backend; only the fulfillment channel differs, and the runner picks it for you: Claude uses its `outputFormat`, Codex its strict `outputSchema`, while Pi, OpenCode, and eligible custom ACP agents receive a client-hosted `StructuredOutput` MCP tool when they advertise HTTP MCP support. Pi accepts stdio, Streamable HTTP, and SSE MCP servers. If no valid tool capture exists, Pi retains the runner's common prompt-embedded schema and validated final-text JSON fallback. In every channel the runner validates the value client-side (with type coercion) and re-prompts a bounded number of times before failing the call with non-recoverable `SCHEMA_NONCOMPLIANCE`.

Schema authoring rules that keep all channels healthy:

- Root must be an object; set `additionalProperties: false` and list every property in `required`.
- Put a `description` on every field — descriptions are the per-field prompt.
- Keep schemas structurally simple. Exotic keywords (`oneOf`, `patternProperties`, unusual `format`s, backreference regexes) are normalized or stripped on the wire for some backends — validation still enforces them client-side, which shows up as re-prompt churn. Prefer `anyOf`, `enum`, and plain types.
- Keep free-text fields small (tens of lines). An oversized structured output can exhaust schema repair and fail the call.
- Validation checks structure, not truth. Check load-bearing values in script code (for example, reject findings whose `file` is not in a known file list) before spending more agents on them.
