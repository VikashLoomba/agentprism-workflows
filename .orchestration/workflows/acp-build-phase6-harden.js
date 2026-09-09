export const meta = {
  name: 'acp-build-phase6-harden',
  description: 'Close the Phase-4 re-run gaps: de-vendor codex-acp to an npm dep + pnpm patch (#2), then live-e2e test (#1), effort/Fast fallback signal (#4), exact-then-substring permissions (#3), wire/remove runId (#5)',
  phases: [
    { title: 'Setup', detail: 'cut one worktree off the current build/acp-mcp tip' },
    { title: 'Packaging', detail: '#2 remove vendored codex-acp; add @agentclientprotocol/codex-acp@1.0.2 + pnpm patchedDependencies; spawn from node_modules' },
    { title: 'Fixes', detail: '#3 exact-then-substring permission match, #4 effort/Fast fallback signal, #5 wire-or-remove runId — each with tests, green' },
    { title: 'LiveTest', detail: '#1 committed env-gated live-backend e2e test; run once green to prove the patched npm dep works end-to-end' },
    { title: 'Integrate', detail: 'merge into build/acp-mcp, full build+test green (default suite skips the live e2e)' },
    { title: 'Record', detail: 'commit + handoff + doc/memory updates' },
  ],
}

const REPO = '/home/vikash/agentprism-workflows'
const ORCH = `${REPO}/.orchestration`
const BASE_BRANCH = 'build/acp-mcp'
const WT = '/home/vikash/agentprism-worktrees'
const W = `${WT}/phase6`
const GT = `${ORCH}/ground-truth.json`
const SMOKE_HARNESS = '/tmp/claude-1000/-home-vikash-agentprism-workflows/457dd4e8-a7d6-4cb8-bc8a-608bdf0c3cfd/scratchpad/smoke3.mjs'
const MAX_ROUNDS = 4

const DOD = "DEFINITION OF DONE (strict): every change ships with tests that ACTUALLY RUN GREEN (pnpm test) — no .skip on the DEFAULT suite, no weakened/trivially-true assertions, no `as any`/@ts-ignore/stubs/TODO to force a pass. Touch only what the task needs; keep the AgentRunner seam + hashAgentCall identity unchanged (no new option enters the resume hash). Leave ZERO TODOs/'follow-up' for agreed work. If something is genuinely ambiguous, STOP and record it in notes with a precise question rather than guessing or deferring."

const SETUP_SCHEMA = { type: 'object', additionalProperties: false, required: ['baseSha', 'worktreePath', 'branch'], properties: { baseSha: { type: 'string' }, worktreePath: { type: 'string' }, branch: { type: 'string' } } }
const STEP_SCHEMA = { type: 'object', additionalProperties: false, required: ['commitSha', 'filesChanged', 'testsPass', 'notes'], properties: { commitSha: { type: 'string' }, filesChanged: { type: 'array', items: { type: 'string' } }, testsPass: { type: 'boolean' }, addedTests: { type: 'number' }, escalations: { type: 'array', items: { type: 'string' } }, notes: { type: 'string' } } }
const LIVE_SCHEMA = { type: 'object', additionalProperties: false, required: ['commitSha', 'testFile', 'gatedSkipByDefault', 'ranLiveGreen', 'claudePass', 'codexPass', 'notes'], properties: { commitSha: { type: 'string' }, testFile: { type: 'string' }, gatedSkipByDefault: { type: 'boolean' }, ranLiveGreen: { type: 'boolean' }, claudePass: { type: 'boolean' }, codexPass: { type: 'boolean' }, addedTests: { type: 'number' }, notes: { type: 'string' } } }
const INTEG_SCHEMA = { type: 'object', additionalProperties: false, required: ['buildOk', 'testsPass', 'totalTests', 'failures'], properties: { buildOk: { type: 'boolean' }, testsPass: { type: 'boolean' }, totalTests: { type: 'number' }, failures: { type: 'array', items: { type: 'string' } }, notes: { type: 'string' } } }
const RECORD_SCHEMA = { type: 'object', additionalProperties: false, required: ['commitSha', 'buildOk', 'testsPass', 'totalTests', 'notes'], properties: { commitSha: { type: 'string' }, buildOk: { type: 'boolean' }, testsPass: { type: 'boolean' }, totalTests: { type: 'number' }, notes: { type: 'string' } } }

phase('Setup')
const setup = await agent(
  `Verify the main repo ${REPO} is on ${BASE_BRANCH} (else STOP). Create ONE self-managed worktree at ${W} on a new branch phase6/harden off the current HEAD (remove any stale ${W} dir AND any stale phase6/harden branch first; if ${W} exists on disk but is untracked, rm -rf it): git -C ${REPO} worktree add -b phase6/harden ${W} HEAD. Run \`pnpm install --frozen-lockfile\` inside ${W} so the test runner works. Report baseSha (HEAD), worktreePath, branch.`,
  { label: 'setup', phase: 'Setup', schema: SETUP_SCHEMA }
)

phase('Packaging')
const packaging = await agent(
  `Work ENTIRELY inside the worktree ${W} (git -C ${W} for git). GOAL (#2 from the Phase-4 re-run critic): the Codex backend must work on a CLEAN checkout via \`git clone && pnpm install && pnpm build\`, NOT via a gitignored vendored build. Today CodexBackend spawns packages/acp-agents/vendor/codex-acp/dist/index.js, which is gitignored and only produced by the opt-in build:codex-vendor script — so Codex silently fails to ship. FIX by de-vendoring to the published npm package + a pnpm-NATIVE patch.\n\n` +
  `MECHANISM — use pnpm's native patchedDependencies (this is a pnpm@10 workspace; do NOT use the patch-package npm tool — pnpm-native is the correct, reliable equivalent and needs no postinstall hook). Steps:\n` +
  `1) Add the dependency to packages/acp-agents/package.json: "@agentclientprotocol/codex-acp": "1.0.2" (EXACT pin, no caret — the patch is byte-anchored to 1.0.2). It is published on npm (integrity sha512-4Cxkk...). Its only runtime extra is @openai/codex (its own dependency); pnpm installs that transitively.\n` +
  `2) Create the patch with pnpm: \`pnpm patch @agentclientprotocol/codex-acp@1.0.2\` (run from ${W}; capture the printed temp edit dir). The published package ships a single NON-minified esbuild bundle dist/index.js (~28.9k lines). In that temp dir's dist/index.js, find the SOLE \`this.codexClient.runTurn({ ... }, onTurnStarted)\` call whose params object ends with the property \`serviceTier\` (preceded by threadId, input, approvalPolicy, sandboxPolicy, summary, effort, model). Inject EXACTLY ONE functional property so the params become:\n` +
  '```\n' +
  '      model: modelId.model,\n' +
  '      serviceTier,\n' +
  '      outputSchema: request._meta?.["agentprism/outputSchema"] ?? null\n' +
  '    }, onTurnStarted);\n' +
  '```\n' +
  `(i.e. add a comma after serviceTier and the outputSchema line — a faithful port of the vendored src/CodexAcpClient.ts:597 patch; you MAY include the explanatory comment block but the functional line is the requirement). Then \`pnpm patch-commit <tempdir>\`, which writes patches/@agentclientprotocol__codex-acp@1.0.2.patch and adds pnpm.patchedDependencies to the ROOT package.json. COMMIT the patch file + lockfile + manifests.\n` +
  `3) Update packages/acp-agents/src/backends/codex.ts spawnConfig: resolve the bin from node_modules instead of ../../vendor/... — keep the AGENTPRISM_CODEX_ACP_CMD/ARGS and AGENTPRISM_CODEX_ACP_BIN overrides; default to resolving the installed package's main (dist/index.js) robustly from ESM, e.g. createRequire(import.meta.url).resolve("@agentclientprotocol/codex-acp"). Run it with process.execPath. Update the module's header comment to say "installed npm dep @agentclientprotocol/codex-acp, patched via pnpm patchedDependencies" (not "vendored").\n` +
  `4) DELETE the vendored tree packages/acp-agents/vendor/codex-acp entirely (git rm -r) and remove the now-dead build:codex-vendor script from packages/acp-agents/package.json. Remove any vendor-specific .gitignore lines that are now orphaned. Leave NO reference to vendor/codex-acp anywhere (grep to confirm: only docs you intentionally update may mention the history).\n` +
  `5) PROVE it ships from npm: in a SEPARATE scratch clone is overkill — instead, inside ${W}, blow away node_modules for acp-agents and re-run \`pnpm install\` (NOT --frozen if the lockfile changed), then assert the patch applied by checking node_modules/.pnpm/@agentclientprotocol+codex-acp@1.0.2*/node_modules/@agentclientprotocol/codex-acp/dist/index.js CONTAINS the string 'agentprism/outputSchema'. Then \`pnpm build\` (all 4 workspace packages) green.\n` +
  `6) Keep the existing acp-agents structured-output/pool/usage tests green (they use the fake ACP agent and don't depend on the real codex bin). Update README §2/§7 + ${GT} corrections wording that describes Codex delivery as "vendored" to reflect the new "npm dep + pnpm patch" reality (keep it accurate; this is load-bearing for future verification).\n\n${DOD}`,
  { label: 'packaging', phase: 'Packaging', schema: STEP_SCHEMA }
)
log(`Packaging: testsPass=${packaging?.testsPass} files=${packaging?.filesChanged?.length ?? '?'} escalations=${packaging?.escalations?.length ?? 0}`)

phase('Fixes')
const fixes = await agent(
  `Work in the SAME worktree ${W} (continue branch phase6/harden, building on the Packaging commit ${packaging?.commitSha}). Implement the 3 contained Phase-4 re-run gaps, each WITH tests, commit when \`pnpm test\` is green.\n\n` +
  `(#3 exact-then-substring permissions) packages/acp-agents/src/permissions.ts currently matches allow/deny lists against the request title/kind/_meta.toolName with bidirectional substring (n===p || n.includes(p) || p.includes(n)), which silently over-allows ('read' matches 'thread-reader') and over-denies (allow-list 'bash' fails to match a title 'Run shell command' and then the non-empty allow-list DENIES on no-match). TIGHTEN to a precedence ladder: (a) prefer an EXACT match (case-insensitive, against _meta.toolName first if present, else title/kind); (b) only if no exact match exists anywhere in the relevant list, fall back to substring. Preserve current semantics where unambiguous. Tests: exact name wins; 'read' no longer matches 'thread-reader' when an exact entry exists; an allow-listed exact tool is allowed; document the residual ambiguity in a comment.\n\n` +
  `(#4 effort/Fast fallback signal) packages/acp-agents/src/acp-client.ts SessionHandle.applyModelModifiers silently skips reasoning_effort / Fast-mode when the requested value (from the model[effort] encoding) is NOT advertised in the session catalog — unlike model selection, which fires onModelFallback (runner.ts ~:183). ADD a symmetric signal: when a requested effort or Fast-mode value can't be applied because it isn't advertised, surface it the SAME way model fallback is surfaced (an onModelFallback-style callback / the same fallback notification channel / engine log) so incorrect tiering is observable — do NOT throw (best-effort stays best-effort), just make the no-op visible. Wire it through to wherever onModelFallback is consumed. Test (mock catalog): a model[high] spec whose 'high' effort is NOT advertised triggers the fallback signal exactly once; an advertised effort does NOT.\n\n` +
  `(#5 wire-or-remove runId) packages/shared-types/src/meta.ts declares META_KEYS.runId ('agentprism/runId', 'for tracing/telemetry') but it is never stamped on any ACP request (only META_KEYS.outputSchema is used). DECIDE and implement ONE: EITHER (preferred) WIRE it — stamp the engine runId onto outgoing session/new (or session/prompt) _meta so it's a real correlation id end-to-end (thread the runId from the engine/runner into acp-client request _meta; add a test asserting it rides the request), OR if wiring is genuinely not clean given the current seam, DELETE the dead constant + its tests so nothing implies a capability that doesn't exist. State which you chose and why in notes. If you wire it, it must NOT enter hashAgentCall.\n\n${DOD}`,
  { label: 'fixes', phase: 'Fixes', schema: STEP_SCHEMA }
)
log(`Fixes: testsPass=${fixes?.testsPass} (+${fixes?.addedTests ?? '?'} tests) escalations=${fixes?.escalations?.length ?? 0}`)

phase('LiveTest')
const live = await agent(
  `Work in the SAME worktree ${W} (continue branch phase6/harden, building on ${fixes?.commitSha}). Implement #1 from the Phase-4 re-run critic: a COMMITTED, env-GATED live-backend end-to-end regression test, so the two structured-output cruxes have a re-runnable guard against the REAL adapters (today every test speaks ACP to a fake). \n\n` +
  `- Adapt the existing orchestration-time smoke harness at ${SMOKE_HARNESS} (it spawns the REAL built mcp-server over stdio via the MCP SDK StdioClientTransport, lists tools so the client-side outputSchema validator compiles, and for each backend calls the "workflow" tool with a parallel() of THREE schema'd agents at concurrency:3, asserting schema-validated structured objects + progress + pooling reuse) into a COMMITTED test under packages/mcp-server/test/ (e.g. live-backend.e2e.test.ts) using node:test + tsx.\n` +
  `- GATE it: it MUST be skipped by default (e.g. test.skip unless process.env.AGENTPRISM_LIVE_E2E === '1'), so the DEFAULT \`pnpm test\` stays deterministic and green WITHOUT creds/network. Assert per backend (claude + the now-npm-installed PATCHED codex): all three results are typebox-validated structured objects (not text), progress fired, and EXACTLY ONE long-lived backend ACP subprocess served the three sessions (pooling reuse). If a backend can't authenticate, the test should FAIL with a clear message when gated ON (not silently pass).\n` +
  `- PROVE it: run it ONCE with AGENTPRISM_LIVE_E2E=1 from ${W} against the real backends on this box (Claude via ~/.claude/.credentials.json; Codex via ~/.codex/auth.json + codex-cli). This is also the acceptance test that the de-vendored npm-installed + pnpm-patched codex-acp actually drives structured output end-to-end (NOT the old vendor path). Report claudePass, codexPass, that it's skip-by-default, that it ran green live, and the observed per-backend process count.\n` +
  `- Confirm the DEFAULT suite (no env var) still skips it and stays green. Commit.\n\n${DOD}`,
  { label: 'livetest', phase: 'LiveTest', schema: LIVE_SCHEMA }
)
log(`LiveTest: gatedSkip=${live?.gatedSkipByDefault} ranLiveGreen=${live?.ranLiveGreen} claude=${live?.claudePass} codex=${live?.codexPass}`)

phase('Integrate')
const P6 = `${ORCH}/phase6-harden.json`
let status = null
for (let round = 1; round <= MAX_ROUNDS; round++) {
  status = await agent(
    round === 1
      ? `In the MAIN repo ${REPO}: checkout ${BASE_BRANCH}, verify HEAD==${BASE_BRANCH}, then merge phase6/harden by its tip commit SHA (--no-ff). The branch tip is the LiveTest commit (${live?.commitSha}); if that is null use the Fixes commit (${fixes?.commitSha}). After merging, run \`pnpm install\` (the lockfile changed — codex-acp added + patchedDependencies), then \`pnpm test\` (build + all tests; the live e2e MUST be skipped since AGENTPRISM_LIVE_E2E is unset). Report buildOk, testsPass, totalTests, and a precise failure list. Do NOT weaken any test; do NOT set AGENTPRISM_LIVE_E2E.`
      : `Round ${round}: make the FULL default suite green (build + tests, live e2e skipped). Fix real failures at the source; never .skip the default suite / weaken assertions. Re-run \`pnpm install\` if the lockfile is implicated, then \`pnpm test\`; report buildOk, testsPass, totalTests, remaining failures.`,
    { label: `integrate:r${round}`, phase: 'Integrate', schema: INTEG_SCHEMA }
  )
  log(`round ${round}: build=${status.buildOk} tests=${status.testsPass} total=${status.totalTests} fails=${status.failures?.length ?? 0}`)
  if (status.buildOk && status.testsPass) break
}

phase('Record')
const rec = await agent(
  `Commit the integrated result on ${BASE_BRANCH} ("feat: de-vendor codex-acp to npm dep + pnpm patch; live-e2e test, effort/Fast fallback signal, exact-then-substring permissions, runId correlation"). Remove the phase6 worktree (git -C ${REPO} worktree remove --force ${W}; also delete the phase6/harden branch if merged). WRITE ${P6} = {commitSha, buildOk, testsPass, totalTests, notes} reflecting:\n${JSON.stringify(status)}\nAlso note in the file: the chosen #5 runId disposition, whether the live e2e ran green (${JSON.stringify({ ranLiveGreen: live?.ranLiveGreen, claudePass: live?.claudePass, codexPass: live?.codexPass })}), and any escalations from Packaging/Fixes.`,
  { label: 'record', phase: 'Record', schema: RECORD_SCHEMA }
)

return { setup, packaging, fixes, live, status, rec }
