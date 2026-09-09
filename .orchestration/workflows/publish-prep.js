export const meta = {
  name: 'publish-prep',
  description: 'Make the monorepo publishable under @automatalabs: scope rename, publish-grade packaging (publishConfig), the @automatalabs/workflows SDK package, Changesets + CI scaffolding. No actual publish.',
  phases: [
    { title: 'Setup', detail: 'worktree off main on build/publish-prep' },
    { title: 'Rename', detail: '@agentprism/* -> @automatalabs/* (npm scope ONLY; protocol keys/env/dirs/bin unchanged)' },
    { title: 'Packaging', detail: 'per package: un-private, version, files:[dist], publishConfig dist-types override (keep dev source-resolution)' },
    { title: 'SDK', detail: 'new @automatalabs/workflows thin-facade package + test' },
    { title: 'CI', detail: 'Changesets config + .github/workflows ci.yml & release.yml + .nvmrc + initial changeset' },
    { title: 'Integrate', detail: 'merge into main, full build+test green' },
    { title: 'Record', detail: 'commit + handoff' },
  ],
}

const REPO = '/home/vikash/agentprism-workflows'
const ORCH = `${REPO}/.orchestration`
const BASE_BRANCH = 'main'
const WT = '/home/vikash/agentprism-worktrees'
const W = `${WT}/publish-prep`
const MAX_ROUNDS = 4

const DOD = "DEFINITION OF DONE (strict): every change keeps `pnpm test` (build + all packages) GREEN and the DEV build unbroken (`pnpm -r exec tsc -b` and `pnpm -r exec tsc --noEmit` both clean) — no .skip on the default suite, no weakened assertions, no `as any`/@ts-ignore/stubs/TODO. Keep the AgentRunner seam + hashAgentCall identity unchanged (no new option enters the resume hash). Do NOT change any protocol `_meta` key (META_NS / agentprism/outputSchema / agentprism/runId in shared-types/src/meta.ts), the AGENTPRISM_* env vars, the .agentprism/ runtime dirs / agentprism/wf branch prefix, or the agentprism-workflow(s) bin/server/clientInfo identifiers — those stay agentprism/* by explicit decision (npm-scope-only rebrand). Do NOT run `npm publish` or `pnpm publish` (no real publish in this workflow). If something is genuinely ambiguous, STOP and record it in notes with a precise question rather than guessing or deferring."

const SETUP_SCHEMA = { type: 'object', additionalProperties: false, required: ['baseSha', 'worktreePath', 'branch'], properties: { baseSha: { type: 'string' }, worktreePath: { type: 'string' }, branch: { type: 'string' } } }
const STEP_SCHEMA = { type: 'object', additionalProperties: false, required: ['commitSha', 'filesChanged', 'testsPass', 'buildOk', 'notes'], properties: { commitSha: { type: 'string' }, filesChanged: { type: 'array', items: { type: 'string' } }, testsPass: { type: 'boolean' }, buildOk: { type: 'boolean' }, addedTests: { type: 'number' }, escalations: { type: 'array', items: { type: 'string' } }, notes: { type: 'string' } } }
const INTEG_SCHEMA = { type: 'object', additionalProperties: false, required: ['buildOk', 'testsPass', 'totalTests', 'failures'], properties: { buildOk: { type: 'boolean' }, testsPass: { type: 'boolean' }, totalTests: { type: 'number' }, failures: { type: 'array', items: { type: 'string' } }, notes: { type: 'string' } } }
const RECORD_SCHEMA = { type: 'object', additionalProperties: false, required: ['commitSha', 'buildOk', 'testsPass', 'totalTests', 'notes'], properties: { commitSha: { type: 'string' }, buildOk: { type: 'boolean' }, testsPass: { type: 'boolean' }, totalTests: { type: 'number' }, notes: { type: 'string' } } }

phase('Setup')
const setup = await agent(
  `Verify the main repo ${REPO} is on ${BASE_BRANCH} and clean (else STOP). Create ONE self-managed worktree at ${W} on a new branch build/publish-prep off the current HEAD (remove any stale ${W} dir AND any stale build/publish-prep branch first; if ${W} exists on disk but is untracked, rm -rf it): git -C ${REPO} worktree add -b build/publish-prep ${W} HEAD. Run \`pnpm install --frozen-lockfile\` inside ${W}. Report baseSha (HEAD), worktreePath, branch.`,
  { label: 'setup', phase: 'Setup', schema: SETUP_SCHEMA }
)

phase('Rename')
const rename = await agent(
  `Work ENTIRELY inside the worktree ${W} (git -C ${W}). Rename the npm scope @agentprism/* -> @automatalabs/* as a PURE MECHANICAL find/replace. The 4 packages are @agentprism/{shared-types,acp-agents,workflow-engine,mcp-server}. CHANGE exactly these categories:\n` +
  `- the 4 packages/*/package.json "name" fields;\n` +
  `- the 5 inter-package "workspace:*" dependency KEYS (acp-agents->shared-types; workflow-engine->shared-types; mcp-server->shared-types+acp-agents+workflow-engine);\n` +
  `- every \`from "@agentprism/..."\` import specifier in packages/*/src and packages/*/test (~20);\n` +
  `- cosmetic @agentprism/ mentions in code comments + test-name strings (for cleanliness).\n` +
  `Then run \`pnpm install\` inside ${W} (regenerates pnpm-lock.yaml @automatalabs entries + relinks workspace symlinks — do NOT hand-edit the lockfile; the @agentclientprotocol/codex-acp pnpm.patchedDependencies entry is a THIRD-PARTY dep and stays unchanged).\n\n` +
  `DO NOT TOUCH (explicit decision — npm-scope-only): packages/shared-types/src/meta.ts META_NS/META_KEYS (agentprism / agentprism/outputSchema / agentprism/runId) and the byte-anchored patches/@agentclientprotocol__codex-acp@1.0.2.patch; the AGENTPRISM_* env vars; the .agentprism/ runtime dirs + agentprism/wf/ branch prefix (workflow-engine config/worktree/paths); the agentprism-workflow MCP bin + SERVER_NAME + the acp-client clientInfo name "agentprism-workflows"; the root package.json "name" (agentprism-workflows); and absolute repo paths in .claude/workflows + .orchestration. Verify with: \`git -C ${W} grep -n "agentprism/outputSchema\\|agentprism/runId\\|META_NS" -- packages/shared-types/src/meta.ts\` still shows agentprism, and \`git -C ${W} grep -rn "@agentprism/" -- packages\` returns NOTHING after the rename.\n` +
  `Confirm \`pnpm -r exec tsc -b\` + \`pnpm -r exec tsc --noEmit\` clean and \`pnpm test\` green, then commit to build/publish-prep. Report buildOk, testsPass.\n\n${DOD}`,
  { label: 'rename', phase: 'Rename', schema: STEP_SCHEMA }
)
log(`Rename: build=${rename?.buildOk} tests=${rename?.testsPass} files=${rename?.filesChanged?.length ?? '?'}`)

phase('Packaging')
const packaging = await agent(
  `Work in the SAME worktree ${W} (continue branch build/publish-prep, building on ${rename?.commitSha}). Make all 4 packages (now @automatalabs/{shared-types,acp-agents,workflow-engine,mcp-server}) PUBLISH-GRADE without breaking the dev build. Per package edit packages/*/package.json:\n` +
  `- remove "private": true;\n` +
  `- set "version": "0.1.0" (all four, version-linked);\n` +
  `- add "files": ["dist"]  <-- MANDATORY: .gitignore ignores dist/, so without a files allowlist npm pack would ship an EMPTY tarball;\n` +
  `- KEEP the existing top-level "exports"/"types" pointing at ./src/index.ts (this preserves the dev-time source-resolution that the monorepo build relies on — do NOT repoint the top-level fields to dist, that risks breaking cross-package type resolution / forcing project references);\n` +
  `- ADD a "publishConfig" that OVERRIDES the published manifest to point types/exports/main at the compiled dist (pnpm 10 applies publishConfig field overrides at publish/pack time): { "access": "public", "main": "./dist/index.js", "types": "./dist/index.d.ts", "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js", "default": "./dist/index.js" } } }. For mcp-server also keep its "bin" (agentprism-workflow -> ./dist/index.js) and mirror it in publishConfig if needed.\n` +
  `- add a "prepublishOnly": "tsc -b" (or "prepack") so dist is fresh before packing.\n` +
  `VERIFY the publishConfig override actually works WITHOUT publishing: in each package run \`pnpm pack --dry-run\` (or \`npm pack --dry-run --json\`) and confirm (a) the tarball file list INCLUDES dist/index.js + dist/index.d.ts, and (b) the packed manifest's types/exports resolve to ./dist/... (pnpm rewrites them from publishConfig) — capture this evidence in notes. Do NOT actually publish.\n` +
  `Then confirm the DEV build is still intact: \`pnpm -r exec tsc -b\`, \`pnpm -r exec tsc --noEmit\`, and \`pnpm test\` all green (the top-level src-resolution is unchanged, so this must still pass). If switching anything surfaces a latent .d.ts emit error, fix it at the source. Commit. Report buildOk, testsPass, and the pack-dry-run evidence in notes.\n\n${DOD}`,
  { label: 'packaging', phase: 'Packaging', schema: STEP_SCHEMA }
)
log(`Packaging: build=${packaging?.buildOk} tests=${packaging?.testsPass}`)

phase('SDK')
const sdk = await agent(
  `Work in the SAME worktree ${W} (continue branch build/publish-prep, building on ${packaging?.commitSha}). Create the importable SDK package @automatalabs/workflows as a THIN FACADE re-export barrel — programmatic dynamic-workflow runner backed by the default ACP AgentRunner, SEPARATE from the MCP stdio server. Add packages/workflows/ as a new workspace package (pnpm-workspace.yaml already globs packages/*, so no glob edit needed; DO add it to the root tsconfig.json "references" list).\n\n` +
  `package.json: name @automatalabs/workflows, version 0.1.0, type module, NOT private, "main"/"types"/"exports" top-level pointing at ./src/index.ts (dev source-resolution, consistent with the others), "files":["dist"], the same publishConfig dist-override pattern as the other packages, "build":"tsc -b", "prepublishOnly":"tsc -b", "test":"tsx --test \\"test/**/*.test.ts\\"". Dependencies (workspace:*): @automatalabs/shared-types, @automatalabs/workflow-engine, @automatalabs/acp-agents. Do NOT depend on @modelcontextprotocol/sdk or zod (keep it a pure library). tsconfig.json mirroring the other packages (extend ../../tsconfig.base.json, rootDir src, outDir dist).\n\n` +
  `src/index.ts re-exports the clean public surface (ALL of these symbols are ALREADY exported by the three deps — verify against their src/index.ts; do NOT widen any existing barrel): from @automatalabs/workflow-engine — runWorkflow, parseWorkflowScript, WorkflowManager, and the option/result types (WorkflowRunOptions, AgentOptions, ExecOptions, WorkflowManagerOptions, CheckpointOptions, WorkflowRunResult, plus WorkflowError, WorkflowErrorCode, isWorkflowError, isProviderUsageLimit); from @automatalabs/acp-agents — createAcpRunner, AcpAgentRunner, selectBackend, ClaudeBackend, CodexBackend, AcpPoolOptions, toJsonSchema, toStrictJsonSchema; from @automatalabs/shared-types — the seam types AgentRunner, RunOptions, AgentResult, AgentUsage (re-export the public types). Also ADD a small convenience helper \`runDynamicWorkflow(script, opts)\` that defaults the AgentRunner seam to createAcpRunner() and otherwise delegates to the engine (new WorkflowManager({ agent: opts.runner ?? createAcpRunner() }).runSync(script, opts.args, opts.exec) — match the ACTUAL engine signatures; read workflow-engine to get them exact). Keep the seam injectable (accept a custom runner).\n` +
  `Add an AMBIENT .d.ts (e.g. src/dsl.d.ts, included in the build) documenting the in-script DSL globals available inside a workflow script (agent, parallel, pipeline, workflow, verify, judgePanel, loopUntilDry, completenessCheck, retry, gate, checkpoint, log, phase, args, budget) for author IntelliSense — these are vm-realm globals, NOT importable functions; read workflow.ts to get the exact set + signatures.\n\n` +
  `Add a TEST packages/workflows/test/sdk.test.ts (node:test + tsx) that imports from the SDK barrel and runs a TINY workflow through a STUB AgentRunner (no live backend) — e.g. a fake runner returning a canned value/object — asserting: (a) the facade re-exports are defined (createAcpRunner, WorkflowManager, runWorkflow, runDynamicWorkflow, WorkflowError, toJsonSchema), and (b) runDynamicWorkflow (or WorkflowManager.runSync) executes a 1-agent \`export const meta\` script with the stub runner and returns the expected result. Model the stub on the mcp-server test harness pattern. Confirm \`pnpm -r exec tsc -b\` + \`pnpm test\` green (the new package builds + its test passes). Commit. Report buildOk, testsPass, addedTests, filesChanged.\n\n${DOD}`,
  { label: 'sdk', phase: 'SDK', schema: STEP_SCHEMA }
)
log(`SDK: build=${sdk?.buildOk} tests=${sdk?.testsPass} (+${sdk?.addedTests ?? '?'} tests)`)

phase('CI')
const ci = await agent(
  `Work in the SAME worktree ${W} (continue branch build/publish-prep, building on ${sdk?.commitSha}). Add Changesets + CI scaffolding (all NEW files; do NOT publish). \n` +
  `- Add changesets: \`pnpm add -Dw @changesets/cli\`, create .changeset/config.json (baseBranch "main", access "public", changelog default, the 5 publishable @automatalabs packages; ignore none). Add an initial changeset (.changeset/*.md) declaring a 0.1.0 minor for all 5 packages with a short summary. Add root scripts: "changeset":"changeset", "version":"changeset version", "release":"pnpm build && changeset publish".\n` +
  `- Add .nvmrc = 22 (root devDep @types/node is ^22, so pin Node 22) and root package.json "engines": { "node": ">=22", "pnpm": ">=10" } (packageManager already pnpm@10.0.0).\n` +
  `- Add .github/workflows/ci.yml (on pull_request + push to main): checkout (fetch-depth 0), pnpm/action-setup pinned to 10.0.0, actions/setup-node@v4 node 22 + pnpm cache, \`pnpm install --frozen-lockfile\` (this re-applies the codex-acp pnpm patch via the lockfile patch_hash AND fetches the linux-x64 codex/claude native binaries — keep runner ubuntu glibc x64, do NOT pass --no-optional), then \`pnpm -r exec tsc -b\`, \`pnpm -r exec tsc --noEmit\`, \`pnpm -r test\`. AGENTPRISM_LIVE_E2E MUST stay unset so the gated live e2e is skipped (deterministic, credential-free).\n` +
  `- Add .github/workflows/release.yml using changesets/action@v1 (permissions contents:write, pull-requests:write, id-token:write for npm provenance): same install+build, then changesets/action with publish="pnpm release" and NPM OIDC trusted publishing (--provenance via pnpm publish -r --access public --no-git-checks inside the release script). IMPORTANT: add a top-of-file comment that this release workflow is a PREREQUISITE-GATED template — it must NOT be relied on to publish until (1) npm auth/OIDC trusted publishing is configured for @automatalabs and (2) the @automatalabs/codex-acp fork is published (else consumers' Codex structured output silently degrades); to keep it dormant for now, trigger it ONLY on workflow_dispatch (manual) rather than on push, so merging to main does not auto-publish.\n` +
  `- Do NOT run any publish. Confirm \`pnpm install\` still consistent and \`pnpm test\` green (changesets is dev-only; CI yaml doesn't run locally). Commit. Report filesChanged, buildOk, testsPass.\n\n${DOD}`,
  { label: 'ci', phase: 'CI', schema: STEP_SCHEMA }
)
log(`CI: files=${ci?.filesChanged?.length ?? '?'} tests=${ci?.testsPass}`)

phase('Integrate')
const PP = `${ORCH}/publish-prep.json`
let status = null
for (let round = 1; round <= MAX_ROUNDS; round++) {
  status = await agent(
    round === 1
      ? `In the MAIN repo ${REPO}: checkout ${BASE_BRANCH}, verify HEAD==${BASE_BRANCH}, then merge build/publish-prep by its tip commit SHA (--no-ff). The branch tip is the CI commit (${ci?.commitSha}); if null, the SDK commit (${sdk?.commitSha}). After merging run \`pnpm install\` (lockfile changed: @automatalabs rename + new workflows package + changesets dev dep), then \`pnpm test\` (build + all tests; AGENTPRISM_LIVE_E2E unset so live e2e skips). Verify NO @agentprism/ remains under packages (git grep). Report buildOk, testsPass, totalTests, precise failures. Do NOT weaken tests; do NOT publish.`
      : `Round ${round}: make the FULL default suite green (build + tests, live e2e skipped). Fix real failures at the source; never .skip/weaken. Re-run \`pnpm install\` if the lockfile is implicated, then \`pnpm test\`; report buildOk, testsPass, totalTests, remaining failures.`,
    { label: `integrate:r${round}`, phase: 'Integrate', schema: INTEG_SCHEMA }
  )
  log(`round ${round}: build=${status.buildOk} tests=${status.testsPass} total=${status.totalTests} fails=${status.failures?.length ?? 0}`)
  if (status.buildOk && status.testsPass) break
}

phase('Record')
const rec = await agent(
  `Commit the integrated result on ${BASE_BRANCH} ("feat: publish-prep — rename scope to @automatalabs, publish-grade packaging, @automatalabs/workflows SDK, Changesets + CI scaffolding"). Remove the publish-prep worktree (git -C ${REPO} worktree remove --force ${W}; delete the build/publish-prep branch if merged). WRITE ${PP} = {commitSha, buildOk, testsPass, totalTests, notes} reflecting:\n${JSON.stringify(status)}\nIn notes also record: the new package list + versions, that NO real publish happened, that the release workflow is manual-dispatch/gated on the codex-acp fork + npm OIDC, the pack-dry-run evidence summary, and any escalations from earlier phases.`,
  { label: 'record', phase: 'Record', schema: RECORD_SCHEMA }
)

return { setup, rename, packaging, sdk, ci, status, rec }
