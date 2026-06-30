export const meta = {
  name: 'acp-build-phase5-completeness',
  description: 'Close the Phase-4 completeness gaps: stopReason, strict-normalize, usage tokens, Codex effort, mcpServers, then ACP connection pooling',
  phases: [
    { title: 'Setup', detail: 'cut one worktree off the current tip' },
    { title: 'Fixes', detail: 'the 5 contained gaps (#2 stopReason, #6 strict, #4 usage, #3 effort, #5 mcpServers) + tests, green' },
    { title: 'Pooling', detail: '#1 long-lived process pool / per-agent session, on top of Fixes, + tests, green' },
    { title: 'Integrate', detail: 'merge into build/acp-mcp, full build+test green' },
    { title: 'Record', detail: 'commit + handoff' },
  ],
}

const REPO = '/home/vikash/agentprism-workflows'
const ORCH = `${REPO}/.orchestration`
const BASE_BRANCH = 'build/acp-mcp'
const WT = '/home/vikash/agentprism-worktrees'
const W = `${WT}/phase5`
const ACP_SDK = `${ORCH}/sdks/agentclientprotocol-sdk-1.0.0/package` // McpServerConfig + session config option types
const MAX_ROUNDS = 4

const DOD = "DEFINITION OF DONE (strict): every change ships with tests that ACTUALLY RUN GREEN (pnpm test) — no .skip, no weakened/trivially-true assertions, no `as any`/@ts-ignore/stubs/TODO to force a pass. Touch only what the task needs; keep the AgentRunner seam + hashAgentCall identity unchanged (new options must NOT enter the resume hash). If something is genuinely ambiguous, STOP and record it in notes with a precise question rather than guessing or deferring."

const SETUP_SCHEMA = { type: 'object', additionalProperties: false, required: ['baseSha', 'worktreePath', 'branch'], properties: { baseSha: { type: 'string' }, worktreePath: { type: 'string' }, branch: { type: 'string' } } }
const STEP_SCHEMA = { type: 'object', additionalProperties: false, required: ['commitSha', 'filesChanged', 'testsPass', 'notes'], properties: { commitSha: { type: 'string' }, filesChanged: { type: 'array', items: { type: 'string' } }, testsPass: { type: 'boolean' }, addedTests: { type: 'number' }, notes: { type: 'string' } } }
const INTEG_SCHEMA = { type: 'object', additionalProperties: false, required: ['buildOk', 'testsPass', 'totalTests', 'failures'], properties: { buildOk: { type: 'boolean' }, testsPass: { type: 'boolean' }, totalTests: { type: 'number' }, failures: { type: 'array', items: { type: 'string' } }, notes: { type: 'string' } } }
const RECORD_SCHEMA = { type: 'object', additionalProperties: false, required: ['commitSha', 'buildOk', 'testsPass', 'totalTests', 'notes'], properties: { commitSha: { type: 'string' }, buildOk: { type: 'boolean' }, testsPass: { type: 'boolean' }, totalTests: { type: 'number' }, notes: { type: 'string' } } }

phase('Setup')
const setup = await agent(
  `Verify the main repo ${REPO} is on ${BASE_BRANCH} (else STOP). Create ONE self-managed worktree at ${W} on a new branch phase5/completeness off the current HEAD (remove any stale ${W} / phase5/completeness first): git -C ${REPO} worktree add -b phase5/completeness ${W} HEAD. Run \`pnpm install --frozen-lockfile\` inside ${W} so the test runner works. Report baseSha (HEAD), worktreePath, branch.`,
  { label: 'setup', phase: 'Setup', schema: SETUP_SCHEMA }
)

phase('Fixes')
const fixes = await agent(
  `Work ENTIRELY inside the worktree ${W} (git -C ${W} for git). Implement the 5 contained completeness gaps the Phase-4 critic found (file:line are in the CURRENT code), each WITH tests, and commit to phase5/completeness only when \`pnpm test\` is green.\n\n` +
  `(#2 stopReason) packages/acp-agents/src/runner.ts discards session.prompt()'s PromptResponse except usage. INSPECT PromptResponse.stopReason and map: 'refusal' -> a NON-recoverable WorkflowError (AGENT_EXECUTION_ERROR, msg like 'model refused to respond') — NOT AGENT_EMPTY_OUTPUT (recoverable -> would burn the whole retry budget re-running a refused prompt); 'max_tokens'/'max_turn_requests' -> a DISTINCT truncation failure (do NOT let it silently become AGENT_EMPTY_OUTPUT or burn all maxSchemaRetries into SCHEMA_NONCOMPLIANCE — surface 'output truncated'); 'cancelled' -> WORKFLOW_ABORTED; 'end_turn' -> existing normal text/schema path. Tests: refusal is not retried; truncation is surfaced distinctly.\n\n` +
  `(#6 strict-normalize) packages/acp-agents/src/schema-strict.ts: when forcing OpenAI-strict (all-required + additionalProperties:false), make originally-OPTIONAL properties NULLABLE (union their type with "null") so optional fields stay expressible; handle strict-UNSUPPORTED composition (OpenAI strict rejects allOf — flatten where trivial, else throw a clear schema error; map oneOf->anyOf if needed). Stay NON-mutating (JSON clone; never touch the schema fed to hashAgentCall). Tests: optional field -> nullable+required; allOf handled; hashed original unchanged.\n\n` +
  `(#4 usage tokens) packages/acp-agents/src/acp-client.ts 'usage_update' case reads only update.cost. ALSO read the token counts (used/size) and feed the UsageAccumulator so AgentUsage.total != 0 when a backend reports tokens via usage_update (not only via PromptResponse.usage). Test: a usage_update with token counts populates AgentUsage.\n\n` +
  `(#3 reasoning_effort/Fast-mode) packages/acp-agents/src/acp-client.ts selectModel only sets the model select. ALSO drive the reasoning_effort SessionConfigOption (from the model[effort] encoding, e.g. 'gpt-5.1-codex[high]' -> 'high') and the Fast-mode option when the catalog advertises them (via session/set_config_option). Test (mock catalog): a model[effort] spec sets reasoning_effort.\n\n` +
  `(#5 mcpServers) Add an OPTIONAL field mcpServers?: McpServerConfig[] to RunOptions in @agentprism/shared-types (additive; do NOT add it to hashAgentCall identity). Thread it through the engine's agent() global (accept {mcpServers}) into the runner opts; in acp-agents populate session/new mcpServers from opts.mcpServers (currently always [] at acp-client.ts:238). Use the ACP McpServerConfig type (see ${ACP_SDK}/dist/schema/types.gen.d.ts). Tests: agent({mcpServers}) reaches session/new; default stays []; a workflow-engine test that the field is plumbed and NOT hashed.\n\n${DOD}`,
  { label: 'fixes', phase: 'Fixes', schema: STEP_SCHEMA }
)
log(`Fixes: testsPass=${fixes?.testsPass} (+${fixes?.addedTests ?? '?'} tests)`)

phase('Pooling')
const pooling = await agent(
  `Work in the SAME worktree ${W} (continue branch phase5/completeness, building on the Fixes commit). Implement #1 ACP CONNECTION POOLING, with tests, green. TODAY acp-agents spawns+kills a backend process PER agent() call (packages/acp-agents/src/acp-client.ts ~:192 spawn / ~:320 kill; runner.ts:44 start / :94 dispose). REFACTOR so the PROCESS lifecycle is POOL-managed and the SESSION lifecycle stays per-agent:\n` +
  `- Per backend (claude / codex) hold a small POOL (default 1, configurable via option/env) of long-lived ACP server processes + their held ACP client connections — ONE initialize per process, reused across agent() calls.\n` +
  `- Per agent() run: ACQUIRE a pooled connection, session/new({ cwd }) (per-session cwd PRESERVES worktree isolation), prompt, then session/close (or release the session) WITHOUT killing the process; RETURN the connection to the pool.\n` +
  `- Concurrency is already capped by the engine limiter (16) — the pool must serve up to that many concurrent sessions per backend (the pinned servers run prompts on different sessions concurrently).\n` +
  `- On process crash/exit: evict + restart it; surface the affected in-flight session's failure as a RECOVERABLE error so the engine retries on a fresh process.\n` +
  `- DISPOSE the whole pool (close every process) when the runner is disposed / the run ends; keep per-session cancellation (opts.signal -> session/cancel) working.\n` +
  `Tests (mock ACP server speaking real ACP over stdio): N agent() calls REUSE one process (assert ONE spawn + ONE initialize, N session/new + N session/close, process NOT killed between calls); a crashed pooled process is restarted and the run continues; pool disposes cleanly (all processes closed). Keep the existing structured-output/usage/permission tests green.\n\n${DOD}`,
  { label: 'pooling', phase: 'Pooling', schema: STEP_SCHEMA }
)
log(`Pooling: testsPass=${pooling?.testsPass}`)

phase('Integrate')
const P5 = `${ORCH}/phase5-completeness.json`
let status = null
for (let round = 1; round <= MAX_ROUNDS; round++) {
  status = await agent(
    round === 1
      ? `In the MAIN repo ${REPO}: checkout ${BASE_BRANCH}, verify HEAD==${BASE_BRANCH}, then merge phase5/completeness by its commit SHA (--no-ff). Read the Pooling step's commitSha (${pooling?.commitSha}) — it is the branch tip. Then \`pnpm test\` (build + all tests). Report buildOk, testsPass, totalTests, and a precise failure list. Do NOT weaken any test.`
      : `Round ${round}: make the FULL suite green (build + tests). Fix real failures at the source; never .skip/weaken. Re-run \`pnpm test\`; report buildOk, testsPass, totalTests, remaining failures.`,
    { label: `integrate:r${round}`, phase: 'Integrate', schema: INTEG_SCHEMA }
  )
  log(`round ${round}: build=${status.buildOk} tests=${status.testsPass} total=${status.totalTests} fails=${status.failures?.length ?? 0}`)
  if (status.buildOk && status.testsPass) break
}

phase('Record')
const rec = await agent(
  `Commit the integrated result on ${BASE_BRANCH} ("feat: ACP connection pooling + close Phase-4 completeness gaps (stopReason, strict-nullable, usage tokens, codex effort, mcpServers)"). Remove the phase5 worktree (git -C ${REPO} worktree remove --force ${W}). WRITE ${P5} = {commitSha, buildOk, testsPass, totalTests, notes} reflecting:\n${JSON.stringify(status)}`,
  { label: 'record', phase: 'Record', schema: RECORD_SCHEMA }
)

return { setup, fixes, pooling, status, rec }
