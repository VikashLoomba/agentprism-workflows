export const meta = {
  name: 'acp-build-phase3-integrate',
  description: 'Merge the 3 module branches, build the workspace, loop-until-green',
  phases: [
    { title: 'Integrate', detail: 'merge branches, build + test, fix-and-rebuild until clean (max 4 rounds)' },
    { title: 'Record', detail: 'commit the integrated workspace and emit the handoff' },
  ],
}

const REPO = '/home/vikash/agentprism-workflows'
const ORCH = `${REPO}/.orchestration`
const P2 = `${ORCH}/phase2-modules.json` // {baseSha, modules:[{module,branch,commitSha,worktreePath}]} (written by Phase 2)
const WT = '/home/vikash/agentprism-worktrees' // where Phase 2's worktrees live (for fallback + cleanup)
const MAX_ROUNDS = 4

const INTEGRATION_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['tscOk', 'testsOk', 'failures'],
  properties: {
    tscOk: { type: 'boolean' },
    testsOk: { type: 'boolean' },
    mergedBranches: { type: 'array', items: { type: 'string' } },
    failures: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['where', 'msg'], properties: { where: { type: 'string' }, msg: { type: 'string' } } } },
    notes: { type: 'string' },
  },
}

const RECORD_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['integrationCommitSha', 'tscOk', 'testsOk', 'remainingFailures', 'notesForPhase4', 'handoffPath'],
  properties: {
    integrationCommitSha: { type: 'string' },
    tscOk: { type: 'boolean' },
    testsOk: { type: 'boolean' },
    remainingFailures: { type: 'array', items: { type: 'string' } },
    notesForPhase4: { type: 'string' },
    handoffPath: { type: 'string' },
  },
}

phase('Integrate')
log('Phase 3: merge module branches, then loop build+test until green')
let status = null
for (let round = 1; round <= MAX_ROUNDS; round++) {
  status = await agent(
    round === 1
      ? `Integrate the three Phase-2 modules in the MAIN repo at ${REPO}. Read ${P2} (= {baseSha, modules:[{module,branch,commitSha,worktreePath}]}). MERGE BY COMMIT SHA (more robust than branch name): for each module run \`git -C ${REPO} merge --no-ff <commitSha> -m "integrate <module>"\`, all three sequentially. They touch DISJOINT packages/<module>/ dirs and none committed root files or the lockfile, so merges MUST be clean — if git reports a conflict it almost certainly means a module violated the "only its package dir" rule, so STOP and report it rather than force-resolving. If a commitSha is unreachable (\`git cat-file -t\` fails), fall back to applying that module's diff from its worktreePath under ${WT}. AFTER all three merge: run a SINGLE \`pnpm install\` at the repo root to regenerate pnpm-lock.yaml from the three merged packages/*/package.json (the lockfile was intentionally NOT committed per-branch to avoid a 3-way lockfile conflict). Then build the whole workspace (\`pnpm -r build\` or \`tsc -b\`), ensure mcp-server's composition root wires an acp-agents AgentRunner into the engine (DI), and run tests (\`pnpm -r test\`). Report tscOk, testsOk, mergedBranches, and a PRECISE list of remaining failures (where = file:line/package, msg). DEFINITION OF DONE (strict): Fully RESOLVE every build/test/type/seam failure — never stub, comment out, 'as any', @ts-ignore, .skip a test, or insert a TODO/'follow-up' to force a green build. If a failure exposes a genuine contradiction with the frozen contract, STOP and surface it rather than papering over it.`
      : `Round ${round}: FIX the remaining build/test/seam failures from the prior round (most will be cross-package type mismatches at the shared-types boundary, missing exports, or import-path issues). Re-run the workspace build + tests. Report tscOk, testsOk, and any remaining failures with location + message. Do NOT touch the frozen shared-types contract unless a failure proves it inconsistent — if so, flag it loudly in notes. DEFINITION OF DONE (strict): Fully RESOLVE every build/test/type/seam failure — never stub, comment out, 'as any', @ts-ignore, .skip a test, or insert a TODO/'follow-up' to force a green build. If a failure exposes a genuine contradiction with the frozen contract, STOP and surface it rather than papering over it.`,
    { label: `integrate:r${round}`, phase: 'Integrate', schema: INTEGRATION_SCHEMA }
  )
  log(`round ${round}: tsc=${status.tscOk} tests=${status.testsOk} failures=${status.failures?.length ?? 0}`)
  if (status.tscOk && status.testsOk) break
}

phase('Record')
const rec = await agent(
  `Commit the integrated workspace at ${REPO} (INCLUDING the regenerated pnpm-lock.yaml) on the current branch with message "integrate: phase-2 modules onto frozen scaffold". Then clean up the now-unneeded Phase-2 worktrees (the phase2/* branches remain in history): for m in workflow-engine acp-agents mcp-server, run \`git -C ${REPO} worktree remove --force ${WT}/$m\` (ignore if already gone). Finally WRITE ${ORCH}/phase3-integration.json = {integrationCommitSha, tscOk, testsOk, remainingFailures, notesForPhase4, handoffPath} reflecting the final integration status:\n${JSON.stringify(status)}`,
  { label: 'record', phase: 'Record', schema: RECORD_SCHEMA }
)

return { status, rec }
