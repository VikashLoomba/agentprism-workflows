export const meta = {
  name: 'acp-build-phase4-verify',
  description: 'Adversarially verify the two cruxes, run a live end-to-end smoke test, and critique completeness',
  phases: [
    { title: 'Verify', detail: 'multi-vote adversarial refute on structured-output (Claude+Codex) and journal/resume' },
    { title: 'Smoke', detail: 'spawn real ACP servers; run a 1-agent schema-d workflow through the MCP tool' },
    { title: 'Critic', detail: 'completeness vs the README tables + ground-truth corrections' },
  ],
}

const REPO = '/home/vikash/agentprism-workflows'
const ORCH = `${REPO}/.orchestration`
const GT = `${ORCH}/ground-truth.json` // corrections WIN
const README = `${REPO}/README.md`
const P3 = `${ORCH}/phase3-integration.json`
const CAS = `${ORCH}/sdks/anthropic-ai-claude-agent-sdk-0.3.195/package`
const VOTERS = 3 // refuters per crux
const BASE_BRANCH = 'build/acp-mcp' // the integrated build branch this phase verifies

const VERDICT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['crux', 'refuted', 'evidence'],
  properties: {
    crux: { type: 'string' },
    refuted: { type: 'boolean' },
    evidence: { type: 'string' },
    fileRefs: { type: 'array', items: { type: 'string' } },
  },
}

const SMOKE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['ran', 'claudePass', 'codexPass', 'details'],
  properties: {
    ran: { type: 'boolean' },
    claudePass: { type: 'boolean' },
    codexPass: { type: 'boolean' },
    details: { type: 'string' },
    errors: { type: 'array', items: { type: 'string' } },
  },
}

const CRITIC_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['complete', 'missing'],
  properties: {
    complete: { type: 'boolean' },
    missing: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['item', 'why'], properties: { item: { type: 'string' }, why: { type: 'string' } } } },
    notes: { type: 'string' },
  },
}

const CRUXES = [
  { key: 'claude-structured-out', claim: 'ClaudeBackend sets _meta.claudeCode.options.outputFormat:{type:"json_schema",schema} AND emitRawSDKMessages:true at session/new, reads structured_output off the raw _claude/sdkMessage carrying type:"result",subtype:"success", then validates — so the engine receives a real Static<schema> object, not text. (Check against the built code and ' + CAS + '/sdk.d.ts.)' },
  { key: 'codex-structured-out', claim: 'CodexBackend forwards the schema via _meta "agentprism/outputSchema" through the PATCHED codex-acp runTurn, NORMALIZES the schema to OpenAI-strict rules first (all props required, additionalProperties:false), reads the final assistant message off the normal stream and JSON.parses + validates it.' },
  { key: 'journal-resume', claim: 'A killed run resumes with a cache-hit on the unchanged prefix: hashAgentCall JSON.stringify output is byte-identical to pi, firstMiss longest-unchanged-prefix is intact, and DETERMINISM_PRELUDE neuters Date.now/Math.random/new Date() inside the vm realm.' },
]

phase('Verify')
log(`Phase 4: adversarial verify — ${CRUXES.length} cruxes x ${VOTERS} refuters each`)
// each crux runs its refuters concurrently, then judges survival from ITS OWN votes (robust to nulls)
const perCrux = (await parallel(CRUXES.map(c => () =>
  parallel(Array.from({ length: VOTERS }, (_unused, v) => () =>
    agent(
      `Adversarially try to REFUTE this claim about the integrated build at ${REPO} (read the actual built source; verify against ${GT} corrections and ${README}). Default refuted=true if you cannot positively confirm it from the code. Refuter #${v + 1}. CLAIM: ${c.claim}`,
      { label: `verify:${c.key}#${v + 1}`, phase: 'Verify', schema: VERDICT_SCHEMA }
    )
  )).then(votes => {
    const got = votes.filter(Boolean)
    const survived = got.length > 0 && got.filter(x => !x.refuted).length > got.length / 2
    return { crux: c.key, survived, refutedCount: got.filter(x => x.refuted).length, votes: got }
  })
))).filter(Boolean)
const cruxStatus = perCrux.map(r => ({ crux: r.crux, survived: r.survived, refutedCount: r.refutedCount }))
const verdicts = perCrux.flatMap(r => r.votes)
log(`Phase 4 cruxes: ${cruxStatus.map(s => `${s.crux}=${s.survived ? 'OK' : 'FAIL'}`).join(' ')}`)

phase('Smoke')
const smoke = await agent(
  `Live end-to-end smoke test of the integrated orchestrator at ${REPO}. Ensure the repo is on ${BASE_BRANCH} (the integrated build branch); build if needed, then drive the REAL built mcp-server over stdio. For EACH backend — a REAL claude-agent-acp (Claude path) and the PATCHED codex-acp (Codex path) — call the "workflow" tool with a MULTI-agent script (a parallel() of THREE schema'd agents, e.g. each \`agent("Return {repo, fileCount} as JSON", {schema: SMALL})\`) and pass concurrency:3 so they run concurrently. ASSERT, per backend: (a) all three results are schema-VALIDATED structured objects (typebox Check), not text; (b) notifications/progress fired; AND (c) POOLING REUSE — while the run executes, poll \`ps\` and confirm EXACTLY ONE long-lived backend ACP subprocess served all three agent() calls (one spawn + one initialize reused across the 3 sessions, NOT three spawns), and that it is NOT killed between the calls. This is the live proof that the pooling refactor reuses one process per backend. Report claudePass, codexPass, the observed per-backend process count, details, and any errors. If a backend cannot authenticate here, report that explicitly rather than marking pass.`,
  { label: 'smoke', phase: 'Smoke', schema: SMOKE_SCHEMA }
)

phase('Critic')
const critic = await agent(
  `Completeness critic. Diff the integrated implementation at ${REPO} against (a) the README §2 tables "Lifted from pi-dynamic-workflows" and "Written fresh", (b) the leaf checklist in README §7, and (c) the ${GT} corrections (Codex patch + strict normalize + clientInfo gate; clamp-not-reject; the ladder). List anything NOT implemented or only stubbed, each with why it matters. Be specific and adversarial about silent gaps.`,
  { label: 'critic', phase: 'Critic', schema: CRITIC_SCHEMA }
)

const confirmed = cruxStatus.filter(s => s.survived).map(s => s.crux)
const failed = cruxStatus.filter(s => !s.survived).map(s => s.crux)
return { cruxStatus, confirmed, failed, smoke, critic, verdicts }
