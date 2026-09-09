# Make workflow execution asynchronous and give the MCP App a run-bound lifecycle

The MCP `workflow` tool currently lets the agent choose whether a run/resume call stays open until execution returns. Workflow duration is unpredictable, and clients may enforce a maximum request timeout even when progress notifications continue. Reliability must not depend on the agent predicting duration or choosing the right execution flag. The current UI association compounds this: every lifecycle action advertises a monitor, including requests with no run, while a fresh foreground run cannot bind its initiating panel until the result supplies its run ID.

Use one asynchronous execution contract for the MCP workflow tool: accepted work is durably owned by the server, `run` and `resume` acknowledge promptly, and observation, presentation, interaction, and result retrieval happen through separate short requests. Remove the configurable foreground/background choice rather than changing its default or documenting which mode the agent should choose.

Improve the app across five related areas, informed by [Excalidraw's MCP App](https://github.com/excalidraw/excalidraw-mcp). The intended experience is that users can open a monitor for an accepted run, inspect setup and execution comfortably, take the next meaningful action, and discuss the selected context with the model.

Deliver this as one complete cutover in the next release containing this work. The agreed model-facing monitor name is `workflow_monitor`. Create a durable run before slow setup or human input, notify on required input and terminal outcomes, and make every unanswered script-authored checkpoint pause until an explicit answer arrives. Remove the checkpoint's headless/default/abort policies entirely. Establish the asynchronous run/view lifecycle before implementing the other interactions. Exact schemas, finite request budgets, and persistence mechanics are implementation responsibilities under these requirements, not additional product decisions.

## Foundation: separate executing a workflow from opening its monitor

Today `CapabilityAwareToolCatalog` attaches `_meta.ui.resourceUri` to the entire `workflow` tool. The declaration applies to every action, including `config`, `status`, `result`, and `stop`; it is not selected by the action's arguments or whether a run was admitted. Consequently the UI handles requests with no run, previews scripts while waiting for identity, and can be replaced by later management calls.

Follow Excalidraw's standard MCP Apps pattern: declare one shared HTML resource URI on the monitor tool, and supply the accepted run ID through each monitor invocation. Each app instance owns its run binding, selection, event cursor, and inspection state. Where the host retains separate panels, opening run B leaves run A's panel observing A; project-local navigation is an optional convenience.

The current Apps discovery contract declares `resourceUri` on the tool definition and does not specify substituting a call's `runId` into it. Use the shared resource with instance-specific data; run-specific resource routing is not part of this proposal.

Tool responsibilities:

| Surface | Responsibility | Opens a monitor? |
| --- | --- | --- |
| `workflow` | Config; asynchronous run/resume; bounded setup/input responses and status/result reads; permission response and stop | No UI association |
| `workflow_monitor({ runId })` | Validate the existing run and present its setup/execution monitor | Yes; the dedicated view entry point |
| `workflow-events` / `workflow-runs` | App-only event paging and project-local navigation | No UI association; retain app-only visibility |

This follows Excalidraw's division of responsibilities: `create_view` declares the UI resource; `read_me` does not, and save/read/export tools are app-only operations without a UI resource association. Excalidraw does render before its checkpoint ID exists because its diagram arguments already supply useful view data. That argument-streaming behavior is not a requirement for a workflow run monitor.

Excalidraw itself uses one resource URI for `create_view`, supplies diagram input to each app instance, and returns a fresh checkpoint ID for each call; persisted edits are keyed by that checkpoint ID. This supports independent diagrams when a host retains separate app instances. A shared resource URI does not inherently mean a shared live panel.

Panel retention belongs to the host. The MCP Apps reference host creates a separate panel per tool invocation; the reviewed pi-mcp-adapter reuses an existing session based on server and tool name. Verify and document target-host behavior without promising that the server can force multiple panels or requiring custom host routing as part of this issue.

The server must not use a global selected run. Views can offer bounded navigation within the selected run's project, with explicit user selection and run-scoped actions. Retained instances remain independent. If the host delivers a new monitor invocation to an existing instance, handle the change of run deliberately: stop previous polling, reset run-specific state, and prevent late responses from the previous run from affecting the new view. User dismissal, host teardown, and reopening also need correct cleanup and recovery; execution remains independent of panel lifetime.

Adding a dedicated model-facing monitor tool deliberately revises the current two-tool public surface. Removing the `background` input and completion-blocking MCP behavior is also an intentional public contract change. Update the schemas, responses, discovery, capability-gating, documentation, examples, and tests together. Remove the retired field and behavior rather than retaining an alias or hidden acceptance path. This proposal does not require splitting every lifecycle action into a separate tool or removing promise-based execution from the lower-level SDK.

## 1. Distinguish background context from conversation messages

Excalidraw saves edits and publishes a debounced, compact description through `updateModelContext`. AgentPrism currently sends selected lifecycle events through `sendMessage({ role: "user" })`: phase starts, pauses, completion, failure, and stop. The root README instead describes `updateModelContext`, so the documented behavior disagrees with the implementation and tests.

Publish bounded context describing the selected run, agent or phase, status, and relevant error. Add an explicit action such as **Ask about this agent** that lets the user bring that selection into the conversation.

Notify automatically when a run needs input (including setup, permissions, checkpoints, or authentication) and when it completes, fails, or is stopped/cancelled. Routine selection, graph activity, and phase starts stay quiet through `updateModelContext`. Explicit discussion actions still send a message. Context updates replace previous context and are intended for future turns; conversation messages may trigger a model response. Notification delivery must respect host capabilities; bounded status remains the universal observation path when the host cannot deliver unsolicited updates.

Acceptance criteria:

- [ ] Context identifies the selected run and node unambiguously and uses bounded, appropriately redacted data. Each update is useful on its own because it replaces the previous context.
- [ ] Concurrent views have a documented context policy. Every update identifies its run and selection; verify host context scoping and document any host limitation that retains only the latest app context. App-owned state and teardown must remain isolated between instances.
- [ ] Routine selection and observation changes do not send conversation messages. Explicit discussion actions include the intended selection.
- [ ] Required-input and terminal events notify; routine phase/activity events do not. Test bootstrap/replay, duplicate suppression across multiple panels and reconnects, host rejection, and panel replacement. Reopening a historical view does not replay a backlog of terminal messages.
- [ ] README, implementation, and tests agree on context and message behavior, including when model work may occur.

## 2. Give inline and fullscreen views different jobs

Excalidraw separates its inline preview from fullscreen editing and responds to host display-mode changes, container dimensions, and mobile safe-area insets. AgentPrism already consumes host fonts and style variables, but has no fullscreen request or explicit layout handling for those dimensions and insets.

Provide a compact inline view of the current phase, active agents, usage, and any required action. Use fullscreen for graph exploration and transcript inspection.

Acceptance criteria:

- [ ] Expansion is offered only when the host advertises support; inline operation remains complete when fullscreen is unavailable or rejected.
- [ ] Layout responds to host dimensions, safe areas, and narrow viewports without hiding essential controls.
- [ ] Switching modes, including host-initiated exit, preserves the selected run/node and relevant scroll or viewport state.
- [ ] Both modes retain host styling and usable keyboard navigation.

## 3. Open the monitor against an accepted run and observe setup and execution immediately

**Routing revision:** [explicit agent routing](explicit-agent-routing.md) supersedes the model-selection
setup portion of this design. Setup now covers backend approval only; format-3 immutable routing
admission and actual-call checks replace selected configurations. The historical source request
below is preserved; acceptance, checkpoints, permissions, monitor, and retry contracts still apply.

The useful requirement is live observation of an accepted run, including preparation before execution admission. A preview of partially authored JavaScript is a different product feature and is not required by this issue.

Use durable acceptance followed by explicit presentation:

```text
workflow({ action: "run", ... }) -> promptly acknowledges a durably owned runId
workflow_monitor({ runId }) -> monitor bound to that run, including pending setup
monitor -> app-only event pages and project-local run navigation
workflow({ action: "resume", runId, ... }) -> promptly acknowledges same-run continuation
workflow({ action: "status" | "result" | "stop" | ..., runId }) -> bounded lifecycle response
```

The existing background path provides a starting implementation, not a complete solution by merely changing a default. After bounded structural/source checks, create the durable run and return its ID before slow mock validation, provider probing, or backend approval. Show preparation and any pending setup request in the monitor and status. A declined setup remains an inspectable cancelled run; setup failure remains an inspectable failed run. Preserve the accepted source so a later file edit cannot change what the pending approval authorizes.

Distinguish durable acceptance from execution admission: the acknowledgement guarantees persisted ownership of preparation, not that the script is ready or authorized to execute. Live agent execution remains blocked until required validation and approvals succeed and format-3 immutable routing admission is durably saved. This deliberately replaces the old guarantee that all preflight and setup refusals occur before any run exists; it preserves the safety boundary before live execution. A setup response is a separate bounded operation tied to the exact run and pending request. Setup remains actionable without an open app; neither observation nor monitor opening implicitly approves it.

An unanswered script-authored `checkpoint()` always pauses for an explicit answer. In MCP, persist the pending question, return control, and accept its answer through a subsequent bounded same-run continuation. Remove the `headless` option and every value it previously accepted, including `"pause"`; there is no longer a policy selector. Remove the checkpoint `default` option and automatic default/true responses. Detachment, lack of a panel, dismissal, and interaction timeouts must not invent an answer or choose to abort the run. Explicit user stop/cancellation remains available, and an explicit negative answer still follows the script's authored control flow.

This is a checkpoint DSL/engine contract change, not just an MCP default override. Carry it through the shared types, public SDK facade, script declarations, validation, runtime, and documentation. An SDK host can still collect an explicit answer through its confirmation callback; without such an answer, the checkpoint remains waiting or durably paused. Remove redundant opt-in-to-pause plumbing instead of preserving an alternate headless policy under a host flag. Dry-run validation may simulate answers to inspect a script, but those simulations must never be persisted or consumed as approval for live execution.

Previously recorded explicit answers remain authoritative and replay without re-asking. Historical automatically defaulted answers are not explicit decisions and must not satisfy the new checkpoint invariant through journal replay, same-run continuation, or result reuse. Version and validate the affected persisted contracts as needed; incompatible or ambiguous execution records fail clearly rather than being silently converted into approvals.

The monitor validates the run through the server, then uses its authoritative persisted script and events. Keep the graph's script-based structure where useful, deriving it from the accepted run rather than using incomplete source as a substitute for missing identity.

Completion and pending-input state must remain observable without an open app. Use bounded status/result reads and capability-appropriate notifications where supported; the UI is not the execution owner or the sole delivery path. Expose no completion-wait tool or mode in this change. No lifecycle request waits for a human answer, a retry loop, or arbitrary workflow duration.

Use a durable caller retry identity for mutating acceptance/continuation requests so a timed-out or disconnected caller can recover the accepted run without starting duplicate work. Reusing an identity with different semantic input must fail clearly; intentional new executions require a fresh identity. Same-run continuation must distinguish a retry from a new continuation generation. Persist the identity-to-operation association atomically with acceptance and cover concurrent retries and lost responses. Request/transport failure after acceptance does not imply cancellation of daemon-owned work; explicit stop and actual executor failure have their documented lifecycle behavior. These guarantees remove workflow-duration coupling, not the possibility of every network, host, or admission failure.

Acceptance criteria:

- [ ] Only the dedicated monitor tool declares the run-monitor UI resource. Lifecycle and app-only data tools do not implicitly open or replace a monitor.
- [ ] The monitor requires an explicit run ID and validates it; it never guesses from the newest run or a server-wide current selection. Missing or invalid runs produce a clear error.
- [ ] In hosts that retain separate instances, opening run B preserves run A's live updates, selection, and viewport. Navigation between runs remains optional. Define behavior for opening the same run again and for explicit user navigation.
- [ ] One shared UI resource is declared on the monitor tool. Each instance obtains its run ID from its monitor invocation, with no run-specific resource routing or mutable global run selection. Host reuse/replacement is handled and documented rather than assuming every host retains multiple panels.
- [ ] A newly accepted run can be monitored during preparation, required setup input, and execution, including runs that settle before the monitor opens. Validation or setup refusal after acceptance preserves its run record and reason.
- [ ] No live agent execution occurs before required validation/approval and durable immutable routing admission. Pending setup survives loss of the initiating request and has bounded inspect/respond/stop paths outside the app.
- [ ] Every unanswered script-authored checkpoint pauses for an explicit answer across MCP and SDK execution. App presence, panel teardown, lack of a live callback, and interaction timeout cannot auto-answer or automatically abort the workflow.
- [ ] Remove `headless`, checkpoint `default`, and redundant `pauseOnCheckpoint` opt-in plumbing from the public/runtime contract. Reject retired authored fields clearly, including `headless: "pause"`; do not silently ignore or normalize them.
- [ ] Explicit durable replies replay once under the current contract. Historical automatic defaults and ambiguous decision provenance cannot bypass the checkpoint via continuation or reuse; test cold restart, journal replay, and dry-run/live isolation.
- [ ] `run` and `resume` have one asynchronous MCP contract. Remove the foreground/background choice from input schemas, runtime behavior, examples, and authoring guidance; retired inputs fail clearly.
- [ ] No workflow duration, retry loop, backend interaction, permission request, or checkpoint keeps a lifecycle request open until execution completes. Admission and control/read request bounds are specified and enforced; no unbounded completion-wait path is exposed.
- [ ] Durable admission, lost-response recovery, and retry handling are defined and tested, including discovery of already-accepted work without duplicate execution.
- [ ] Completion, results, and pending permission/checkpoint state remain accessible in non-App hosts and after panel teardown. The migration covers both supported protocol eras and replaces the current foreground-bound interaction paths with the agreed asynchronous lifecycle.
- [ ] Any revised contract lands with its migrations, tests, documentation, generated artifacts where applicable, and appropriate package release changes. Existing foreground inputs/outputs and handlers do not survive as implicit compatibility behavior.
- [ ] The persisted plan and live events drive the graph. Remove pre-run lifecycle workarounds made obsolete by the approved design; partial-script preview is not a delivery requirement.
- [ ] Live updates preserve the user's inspection position; any automatic focus behavior respects user navigation.

## 4. Let users take the next meaningful action inside the app

Excalidraw supports direct editing, saving, and export through app-originated tool calls. Extend AgentPrism's existing inspection and Stop surface to cover the corresponding workflow actions:

- Answer an already-pending permission request using its exact advertised options and scopes.
- Resolve pending setup using the server's exact backend approval request.
- Answer a checkpoint and resume the same run.
- Stop a selected live agent.
- Inspect and copy the authoritative completed result.

Acceptance criteria:

- [ ] Actions use the existing server lifecycle and validation APIs, including exact permission request IDs/options, same-ID resume, and targeted cancellation.
- [ ] These controls present the existing approval and selection requirements through the durable lifecycle; they do not invent additional approvals or relax permission policy. The checkpoint contract change above is delivered across the engine, SDK, and MCP integration.
- [ ] Pending, rejected, stale, and failed actions have clear UI feedback. Controls follow authoritative state rather than assuming a successful request means execution has settled.
- [ ] Completed output comes from the exact-result API/resource, including bounded paging where appropriate; redacted event previews are not used to reconstruct it.
- [ ] Browsing and action delivery remain usable when model-context or conversation-message delivery is unavailable.

## 5. Test the complete app against a controllable host bridge

Excalidraw injects a mock `App` into its production UI component and exposes controls for partial input, final input, results, and display changes. AgentPrism's existing browser preview drives the real graph/detail components with simulated events, alongside server integration tests and a reference-host launcher.

Extend the harness to mount the complete production monitor through a controllable host bridge so it exercises lifecycle and communication behavior as well as rendering.

Acceptance criteria:

- [ ] Deterministic, credential-free scenarios cover monitor input/result delivery, invalid run IDs, cancellation, host context changes, and unavailable/rejected capabilities.
- [ ] Scenarios cover teardown during polling, reconnect/backoff, replacement/reopening of panels, switching runs, and restoration of selection across display modes.
- [ ] With a host that retains separate instances, open A, interact with it, then open B while A is still running: verify that A remains available and updating without requiring run navigation. Exercise simultaneous monitor calls and reopening the same run. Selection, event cursors, commands, persisted view state, and outgoing context identify the intended run; project-local navigation does not become a daemon-wide listing.
- [ ] Exercise hosts that reuse or replace panels: a new invocation binds the reused instance to its requested run, previous polling stops, and late responses cannot contaminate the new view. Verify teardown/reopening and record panel-retention and model-context limitations in the target-host smoke matrix.
- [ ] Non-presentational workflow actions do not request a new view. Monitor startup does not depend on partial tool-input support or on the run remaining active until the panel loads.
- [ ] A simulated workflow that outlives a host request timeout is accepted and acknowledged without waiting for completion; the caller can observe and control it through subsequent bounded requests. Cover the same behavior on resume, slow setup/probes, declined setup, missing progress support, no app, pending permissions/checkpoints, lost replies, concurrent retries, and client disconnection.
- [ ] Tests verify outgoing context, conversation messages, and tool calls, including suppression of unintended messages or duplicate actions.
- [ ] Verification includes the complete permission/checkpoint/result flows and a documented smoke matrix for target MCP hosts; mocks do not stand in for cross-host verification.

## Architecture and delivery

Build on the current app-only event/run tools, bounded polling, durable cursor replay, multi-run navigation, and teardown cleanup. Retain the distinction between exact results and redacted observability.

Implement through AgentPrism's v2 server and era-specific transport seams; Excalidraw's v1 SDK/server-helper wiring is reference material, not a migration target. Keep the current self-contained UI packaging unless measurements establish a reason to change it.

Any intentional contract changes must be identified during design and delivered with the affected implementation, tests, documentation, generated authoring content where relevant, and Changesets. Existing specifications describe the current contracts and migration surface; they do not preclude a better explicitly reviewed design.

Implementation sequence: specify the exact bounded acceptance/setup/control schemas and durable retry mechanics under the agreed behavior; establish the full-app harness around that contract; implement the asynchronous lifecycle, context/message semantics, responsive/fullscreen behavior, and direct controls. The harness should grow alongside each change. A newly discovered material product tradeoff should be surfaced, not silently decided by preserving an obsolete path.

## Next-release cutover and removal checklist

The first release containing this work ships the entire replacement contract. Do not ship both execution modes, stage the behavior behind an opt-in flag, or retain adapters to the retired MCP contract. Coordinate code, schemas, tests, documentation, generated artifacts, and Changesets in one release train; if implementation is split internally, do not publish an intermediate partial cutover.

| Retired surface | Required removal/replacement |
| --- | --- |
| MCP `background` input | Remove it from run/resume schemas, TypeScript input types, normalization, discovery, and runtime branches. Both `background:true` and `background:false` fail Invalid Params; omission always selects the sole asynchronous contract. Add no `foreground`, `mode`, or `wait` alias. |
| MCP foreground execution and split responses | Delete completion-blocking run/resume handlers, MCP-only foreground/background result variants and formatters, and mode-selection branches. Accepted requests return the canonical bounded acceptance/continuation response. Terminal outcomes remain available through status and exact-result retrieval, without a fast-run exception that restores the old run response. |
| Request-owned execution | Remove foreground progress-reporting and request-abort wiring that owns an accepted run. Stop remains explicit. Rework background-only reservation/accounting into the one lifecycle and preserve bounded capacity; deleting a mode must not delete the admission cap. |
| Foreground interaction/retry loops | Replace the workflow-specific request-state flows that keep run/resume active across backend approval, model selection, ACP permissions, and checkpoints. Remove old retry handlers and response guidance such as `interaction.collectWith: ["run", "resume"]`; use exact durable pending-request responses instead. Old workflow continuation tokens must not revive the removed flow. Preserve protocol-era transport support without preserving the old workflow lifecycle. |
| Pre-run setup persistence rule | Replace the rule that all setup/preflight refusal leaves no run record. Slow setup now belongs to the accepted run, with observable waiting, failure, or cancellation. Retain bounded early rejection for malformed inputs and the validation/approval barrier before live execution. |
| Checkpoint headless/default policies | Remove the entire `headless` option (`"default"`, `"abort"`, and `"pause"`), the checkpoint `default` field, implicit `true` responses, and redundant `pauseOnCheckpoint` opt-in plumbing. Delete the corresponding public types, option readers, runtime branches, validation warnings, and authored examples. Retired fields fail clearly. Update checkpoint identity/provenance and persistence contracts so old automatic defaults cannot re-enter execution as recorded approval. |
| Implicit monitor attachment and missing-ID UI | Remove UI metadata from `workflow` lifecycle operations and the UI branches for configuration-only calls, partial-script startup, and missing-run-ID foreground waiting. Keep graph construction from persisted source. Register only `workflow_monitor` as the dedicated view entry point; do not register a hyphenated alias. |
| Routine lifecycle conversation messages | Remove automatic phase-start/activity messages. Use quiet model context for routine updates and the agreed required-input/terminal notification policy. |
| Obsolete tests and guidance | Replace assertions, fixtures, examples, authoring guidance, and implemented-spec prose that require the old modes or request-bound interaction paths. Retain negative tests proving retired inputs/tokens fail; do not keep old behavior as a secondary success case. Regenerate the shipped authoring-skills bundle. |

Full cutover covers the replaced MCP workflow/UI contract and the script-authored checkpoint contract across the engine and SDK. The SDK retains promise-based execution and explicit host confirmation, with the new checkpoint semantics; it must not retain the retired automatic-answer/abort policies. REPL and both explicitly supported MCP protocol eras remain product surfaces. Historical data remains readable through supported current read APIs where its stored data permits. Resume and execution reuse must satisfy the new invariants directly: incompatible records fail with a clear reason and a fresh-run instruction, without guessed metadata, silent migration, or a weaker execution path. This change does not authorize deleting stored user runs.

Acceptance criteria:

- [ ] The published tools/list schemas and server instructions expose `workflow_monitor` and only the new workflow lifecycle; old mode fields and aliases are rejected in both protocol eras and every server transport.
- [ ] Removal coverage searches the shipped source/types, schema artifacts, authored and generated skills, examples, and current docs for retired executable paths. Historical changelog entries and the explicit removal record do not imply live acceptance.
- [ ] Same-run continuation and execution reuse validate all newly required metadata and explicit checkpoint-decision provenance; incompatible records/tokens fail clearly. Cold restart and retry tests cannot enter a retired handler or treat a historical automatic default as an explicit answer.
- [ ] The next release containing this work includes the complete implementation, required checks, generated artifacts, Changesets, and clear breaking-change notes describing new invocation/response and interaction behavior. No compatibility window is offered.

## Evidence and references

Initial comparison: Excalidraw `157aa23ceb1976008aadc89eb05e3444060f09d6`; AgentPrism `0bd4af46`. Twenty-one focused AgentPrism tests passed across app registration/paging, model messages, tool input, and polling backoff. This was source review and automated testing, not live cross-host validation.

- Excalidraw: [edit context](https://github.com/excalidraw/excalidraw-mcp/blob/157aa23ceb1976008aadc89eb05e3444060f09d6/src/edit-context.ts), [app lifecycle and UI](https://github.com/excalidraw/excalidraw-mcp/blob/157aa23ceb1976008aadc89eb05e3444060f09d6/src/mcp-app.tsx), [host mock](https://github.com/excalidraw/excalidraw-mcp/blob/157aa23ceb1976008aadc89eb05e3444060f09d6/src/dev-mock.ts).
- AgentPrism: [monitor](https://github.com/agentprism/agentprism-workflows/blob/0bd4af46/packages/mcp-server/ui/src/main.tsx), [model messages](https://github.com/agentprism/agentprism-workflows/blob/0bd4af46/packages/mcp-server/ui/src/model-messages.ts), [preview harness](https://github.com/agentprism/agentprism-workflows/blob/0bd4af46/packages/mcp-server/ui/src/preview.tsx), [app server surface](https://github.com/agentprism/agentprism-workflows/blob/0bd4af46/packages/mcp-server/src/app-ui.ts), [README context description](https://github.com/agentprism/agentprism-workflows/blob/0bd4af46/README.md#quickstart--mcp-server).
- MCP Apps: [context update semantics](https://apps.extensions.modelcontextprotocol.io/api/classes/app.App.html#updatemodelcontext), [conversation messages](https://apps.extensions.modelcontextprotocol.io/api/classes/app.App.html#sendmessage).
- Tool/view lifecycle: [MCP Apps resource discovery and preloading](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx#resource-discovery), [Excalidraw tool registrations](https://github.com/excalidraw/excalidraw-mcp/blob/157aa23ceb1976008aadc89eb05e3444060f09d6/src/server.ts#L401), [AgentPrism tool catalog](https://github.com/agentprism/agentprism-workflows/blob/0bd4af46/packages/mcp-server/src/tool-catalog.ts).
- Independent views: [reference host panel identity](https://github.com/modelcontextprotocol/ext-apps/blob/352f6ced4d80772e92b4e7a311854481a8d65b04/examples/basic-host/src/index.tsx#L91), [reference host resource resolution](https://github.com/modelcontextprotocol/ext-apps/blob/352f6ced4d80772e92b4e7a311854481a8d65b04/examples/basic-host/src/implementation.ts#L95), [pi adapter session reuse](https://github.com/nicobailon/pi-mcp-adapter/blob/8243eba3421e301c88c047444f34ab7d5d57163e/ui-session.ts#L212), [Excalidraw checkpoint-scoped edit persistence](https://github.com/excalidraw/excalidraw-mcp/blob/157aa23ceb1976008aadc89eb05e3444060f09d6/src/mcp-app.tsx#L816). These are source findings, not live host verification. [MCP Apps issue #558](https://github.com/modelcontextprotocol/ext-apps/issues/558) separately reports context collisions across instances sharing a resource URI; it does not establish visual panel replacement.
- Request lifetime: [MCP timeout guidance](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle#timeouts) recommends a maximum timeout even when progress notifications are received; progress does not establish portable indefinite request lifetime.

## User request — verbatim source

> Is there anything we can learn from excalidraw MCP App for our agentprism mcp app?

Reference supplied: https://github.com/excalidraw/excalidraw-mcp

> Excalidraw is considered to be one of the best production implementations of an MCP App, and I want to know if there are things we can learn about their app for our own.

> I think the 5 items are worth putting in to a single issue on gh. Could you draft it for me to review

> Okay great first draft. One area I want to know about our app is if it serves the same static path for the app regardless of runId. The scenario being what if multiple workflows are running on the server

> Okay I think this issue in particular needs to be solved properly in order to properly implement the list, especially like number 3. We're engineering around it, but we need a better pattern. For one, we shouldn't be returning the resource for the UI before there is a runId. Looking at number 3, I'm actually not sure I understand it, but generally we shouldn't really need to return a UI for every action in the workflows tool, I think. Does this make sense, and fit the example of excalidraw as well? Or am I wrong?

> Okay but most mcp clients timeout long tool calls, so I'm specifically not understanding why we are even providing a configurable "mode" at all for the tool, because agents aren't deterministic and we (as the mcp app authors) can't/shouldn't be providing an execuation path where the tool call times out because a workflow took long, if that makes sense

> This doesn't feel right, because if the agent calls the monitor on one run id, and the user is looking at it actively, and then lets say later the agent calls it again with a different runid, it will remove the old one even if the run is active. What I'm saying is: the resource being served should be specific to the workflow runId, potentially via the path, rather than the same exact static resource path, because that means we force the user to use navigation, rather than it being a nice-to-have. Does that make sense? Is there any reason we shouldn't do it the way I'm proposing?

> Using the excalidraw mcp app as an example - I assume the app UI supports the agent showing two different diagrams at the same time?

> I see, so you're saying its not natively supported by the spec, because the tool definition needs the resource URI up-front? In that case I don't think we should use my solution since its not actually supported, and we should follow excalidraws example.

> Okay great. For the toolname, your proposed name was fine, just make it an underscore not `-`. Is there any other open question that need answering before posting the issue and implementation? You will be doing the implementation, so better to clarify things now. Additionally, want to make sure the stuff we're removing is captured as to not imply backwards-compat routes, since I want a full cutover for the next release

Clarification answers (verbatim user selections; their questions are summarized for context):

When setup still needs backend approval/model selection, create an inspectable durable run before waiting, with execution blocked and declined setup recorded as cancellation:

> Create the run first; show pending setup (Recommended)

Automatic conversation notification policy:

> Notify on required input and terminal outcomes (Recommended)

Earlier checkpoint selection, superseded by the user's later decision below:

> Pause by default; honor explicit headless policy (Recommended)

Final checkpoint decision:

> Okay given that headless is only for script-authored checkpoints, I think we should never have other options i.e. abort or default. If the script itself has a checkpoint, it should pause, to honor the checkpoint, as it was put there for a reason. That should simplify the tool even more as its one less option to worry about

Delivery authorization:

> Okay great. I think its ready to post. Then, create a worktree off latest main and implement each item. Once finished and committed and pushed, release through the repo's standard release process, resolving any dep gates etc that might come up
