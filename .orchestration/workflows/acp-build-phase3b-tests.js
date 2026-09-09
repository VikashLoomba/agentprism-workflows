export const meta = {
  name: 'acp-build-phase3b-tests',
  description: 'Build a real green test suite: port pi engine tests + write fresh acp-agents/mcp-server tests, then integrate green',
  phases: [
    { title: 'Setup', detail: 'add the node:test+tsx runner + per-package test scripts; cut author worktrees' },
    { title: 'Author', detail: '5 parallel authors port/write tests per area, each run GREEN in its worktree' },
    { title: 'Integrate', detail: 'merge the test branches, run the full suite, loop fix->retest until green' },
    { title: 'Record', detail: 'commit + write the handoff' },
  ],
}

const REPO = '/home/vikash/agentprism-workflows'
const ORCH = `${REPO}/.orchestration`
const BASE_BRANCH = 'build/acp-mcp' // the integration base that holds the totality of the build
const WT = '/home/vikash/agentprism-worktrees'
const PI = '/home/vikash/pi-dynamic-workflows' // source of the tests to port (tests/*.test.ts)
const MAX_ROUNDS = 4

const SETUP_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['setupCommitSha', 'runnerNotes', 'worktrees'],
  properties: {
    setupCommitSha: { type: 'string' },
    runnerNotes: { type: 'string', description: 'how `pnpm test` runs (script, resolution of @agentprism/* vs ../src)' },
    worktrees: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['area', 'path', 'branch'], properties: { area: { type: 'string' }, path: { type: 'string' }, branch: { type: 'string' } } } },
  },
}

const AUTHOR_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['area', 'branch', 'commitSha', 'testFiles', 'testsPass', 'assertionCount', 'gapsLeft'],
  properties: {
    area: { type: 'string' },
    branch: { type: 'string' },
    commitSha: { type: 'string' },
    testFiles: { type: 'array', items: { type: 'string' } },
    testsPass: { type: 'boolean', description: 'the area suite actually ran GREEN in the worktree' },
    assertionCount: { type: 'number' },
    gapsLeft: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
}

const INTEG_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['testsPass', 'failures', 'totalTests'],
  properties: {
    testsPass: { type: 'boolean' },
    totalTests: { type: 'number' },
    failures: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['where', 'msg'], properties: { where: { type: 'string' }, msg: { type: 'string' } } } },
    notes: { type: 'string' },
  },
}

const RECORD_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['testsCommitSha', 'testsPass', 'totalTests', 'notesForPhase4'],
  properties: {
    testsCommitSha: { type: 'string' },
    testsPass: { type: 'boolean' },
    totalTests: { type: 'number' },
    notesForPhase4: { type: 'string' },
  },
}

const DOD = 'DEFINITION OF DONE (strict): every test you write must ACTUALLY RUN GREEN against the real implementation — no .skip/.todo, no commented-out assertions, no trivially-true tests, no `as any`/@ts-ignore to force a pass. If a ported pi test exercises behavior we deliberately changed (e.g. .pi->.agentprism paths, typebox at the seam, classifyProviderLimit now in shared-types, dropped run-level tools), ADAPT the test to assert our CORRECT behavior — do not delete coverage to make it pass. If a test reveals a real defect in the implementation, STOP and record it in gapsLeft with a precise repro rather than weakening the test.'

phase('Setup')
log('Phase 3b: set up the test runner + cut author worktrees')
const setup = await agent(
  `Set up a real test runner for the integrated workspace at ${REPO} (currently on ${BASE_BRANCH}). FIRST verify HEAD is on ${BASE_BRANCH}; if not, STOP. Mirror pi's stack: node:test + node:assert/strict run via tsx. Add \`tsx\` (pinned, recent stable ^4) to ROOT devDependencies; add a root "test" script and a per-package "test" script so \`pnpm test\` and \`pnpm -r test\` run every packages/<pkg>/test/**/*.test.ts. Resolve imports so tests can run: same-package unit tests import internals relatively (../src/X.js, exactly like pi's tests/*.test.ts import ../src), cross-package tests import the public @agentprism/* entry (build first if your resolution needs dist — make \`pnpm test\` do whatever build is required so it is green from a clean checkout). Commit on ${BASE_BRANCH} ("test: add node:test+tsx runner + per-package test scripts"). THEN cut 5 SELF-MANAGED worktrees off that commit, OUTSIDE the repo under ${WT}, one branch each (remove any stale first): for a in shared-types engine-core engine-infra acp-agents mcp-server: git -C ${REPO} worktree add -b phase3b/$a ${WT}/tests-$a <setupCommitSha>. Report setupCommitSha + how the runner resolves imports + the 5 {area,path,branch}.`,
  { label: 'setup', phase: 'Setup', schema: SETUP_SCHEMA }
)
log(`Phase 3b: runner ready @ ${setup.setupCommitSha?.slice(0, 8)}; ${setup.worktrees.length} worktrees`)

phase('Author')
const wt = (area) => `${WT}/tests-${area}`
const ISO = (area) => `Work ENTIRELY inside the worktree at ${wt(area)} (git -C ${wt(area)} for all git ops). You are on branch phase3b/${area} off the test-runner setup commit. Write test files ONLY under the matching packages/<pkg>/test/ dir; do NOT touch src, root files, or other packages. Run your area's tests with the package test script and iterate until GREEN, then commit ONLY your test files to phase3b/${area} and report the exact commit SHA + a real assertion count.`
const built = (await parallel([
  () => agent(
    `PORT the shared-types error tests. ${ISO('shared-types')}\nFrom ${PI}/tests/errors.test.ts port the parts that now live in @agentprism/shared-types — classifyProviderLimit (the full wording table + resetHint extraction), isProviderUsageLimit, the WorkflowError class (code/recoverable/resetHint/agentLabel) — into packages/shared-types/test/errors.test.ts importing from ../src/errors.js. (wrapError moved to the engine; it is covered by engine-core, NOT here.) ${DOD}`,
    { label: 'tests:shared-types', phase: 'Author', schema: AUTHOR_SCHEMA }
  ),
  () => agent(
    `PORT the engine CORE tests into packages/workflow-engine/test/. ${ISO('engine-core')}\nPort + adapt from ${PI}/tests: workflow-parser.test.ts (meta extraction + determinism blocklist), workflow-runtime.test.ts (vm realm, DETERMINISM_PRELUDE neutering Date.now/Math.random, agent()/parallel/pipeline incl. the cross-item Promise.all join, budget/phase budgets), the journal hash + firstMiss longest-unchanged-prefix + resume replay, checkpoint.test.ts, schema-resolution.test.ts, structured-output.test.ts, workflow-paths.test.ts, plus wrapError (the engine-local helper that imports classifyProviderLimit from shared-types). Adapt imports to our package (../src/*.js) and our renamed .agentprism paths/typebox. hashAgentCall byte-stability is load-bearing — assert it. ${DOD}`,
    { label: 'tests:engine-core', phase: 'Author', schema: AUTHOR_SCHEMA }
  ),
  () => agent(
    `PORT the engine INFRA tests into packages/workflow-engine/test/. ${ISO('engine-infra')}\nPort + adapt from ${PI}/tests: run-persistence.test.ts (disk journal + leases), worktree.test.ts (now .agentprism/worktrees + agentprism/wf/<slug> branch — update assertions to the consolidated names), model-routing.test.ts, model-tier-config.test.ts (buildDefaultTierConfig with an injected availableModels list; empty => session default), agent-registry.test.ts (now .agentprism/agents; agentDefinitionKey serialization UNCHANGED — assert it), workflow-manager-abort.test.ts (abort + pause/resume + runSync terminal status). Adapt imports/paths; assert our CORRECT consolidated behavior, do not delete coverage. ${DOD}`,
    { label: 'tests:engine-infra', phase: 'Author', schema: AUTHOR_SCHEMA }
  ),
  () => agent(
    `WRITE fresh acp-agents tests into packages/acp-agents/test/ (no network — MOCK the ACP connection/backends). ${ISO('acp-agents')}\nCover: (1) schema-strict normalization — a typebox/JSON schema -> OpenAI-strict rules (every prop required, additionalProperties:false, unsupported keywords stripped) on a COPY, asserting the ORIGINAL hashed schema object is NOT mutated; (2) the Codex path forwards the schema via _meta["agentprism/outputSchema"] into the runTurn/turn-start params (assert against a mock codex client); (3) the Claude path sets _meta.claudeCode.options.outputFormat + emitRawSDKMessages and reads structured_output off a simulated _claude/sdkMessage result; (4) run() stopReason->result/throw mapping incl. provider-wall -> classifyProviderLimit -> WorkflowError(PROVIDER_USAGE_LIMIT, recoverable:false, resetHint); empty no-schema -> AGENT_EMPTY_OUTPUT (recoverable); schema-unsatisfied-after-ladder -> SCHEMA_NONCOMPLIANCE; (5) permission allow/deny auto-response at request_permission; (6) usage_update -> onUsage on success AND error, tolerating usage===undefined; (7) benign clientInfo at initialize (NOT JetBrains/IntelliJ 2026.1). Import internals via ../src. ${DOD}`,
    { label: 'tests:acp-agents', phase: 'Author', schema: AUTHOR_SCHEMA }
  ),
  () => agent(
    `WRITE fresh mcp-server tests into packages/mcp-server/test/ (in-memory MCP client<->server, stub AgentRunner — like the phase-3 smoke). ${ISO('mcp-server')}\nCover: (1) workflowToolInputShape validation — script required, args optional, and BOUNDS CLAMP NOT REJECT (concurrency/agentRetries over-max are ACCEPTED at the tool boundary and clamped by the engine to 16/3, NOT rejected with InvalidParams); no startInBackground field; (2) a completed run -> isError:false, structuredContent == WorkflowRunResult shape (runId/status/result/tokenUsage?/logs), status "completed"; (3) the handler routes through WorkflowManager.runSync (engine owns status/runId; shell does NOT throw on pause/fail — paused -> status "paused" + resetHint passthrough); (4) a malformed script (no meta / no agent()) -> isError:true with the parse message; (5) resumeFromRunId loads the persisted journal and replays. Import internals via ../src. ${DOD}`,
    { label: 'tests:mcp-server', phase: 'Author', schema: AUTHOR_SCHEMA }
  ),
])).filter(Boolean)
log(`Phase 3b authors: ${built.map(b => `${b.area}=${b.testsPass ? 'green' : 'RED'}(${b.assertionCount})`).join(' ')}`)

phase('Integrate')
const P3B = `${ORCH}/phase3b-tests.json`
let status = null
for (let round = 1; round <= MAX_ROUNDS; round++) {
  status = await agent(
    round === 1
      ? `Integrate the 5 Phase-3b test branches in the MAIN repo at ${REPO}. FIRST checkout ${BASE_BRANCH} and verify HEAD==${BASE_BRANCH}. Merge each phase3b/* commit by SHA (--no-ff): shared-types, engine-core, engine-infra, acp-agents, mcp-server (test files are additive + disjoint per package -> clean; a conflict means an author escaped its dir -> STOP). Branch SHAs are here:\n${JSON.stringify(built.map(b => ({ area: b.area, branch: b.branch, commitSha: b.commitSha })))}\nThen run the WHOLE suite: \`pnpm test\` (or \`pnpm -r test\`). Report testsPass, totalTests, and a precise failure list (where=file/test name, msg). Do NOT weaken any test to go green.`
      : `Round ${round}: make the FULL suite green. Fix failures that are test-adaptation issues (imports/paths/our-changed-behavior). If a failure is a REAL implementation defect, fix the source minimally OR record it precisely in notes — never .skip or weaken the test. Re-run \`pnpm test\`; report testsPass, totalTests, remaining failures.`,
    { label: `integrate:r${round}`, phase: 'Integrate', schema: INTEG_SCHEMA }
  )
  log(`round ${round}: pass=${status.testsPass} total=${status.totalTests} fails=${status.failures?.length ?? 0}`)
  if (status.testsPass) break
}

phase('Record')
const rec = await agent(
  `Commit the merged test suite on ${BASE_BRANCH} ("test: port pi engine tests + add acp-agents/mcp-server suites"). Clean up the phase3b worktrees (git -C ${REPO} worktree remove --force ${WT}/tests-<area> for each). WRITE ${P3B} = {testsCommitSha, testsPass, totalTests, notesForPhase4} reflecting:\n${JSON.stringify(status)}`,
  { label: 'record', phase: 'Record', schema: RECORD_SCHEMA }
)

return { setup, built, status, rec }
