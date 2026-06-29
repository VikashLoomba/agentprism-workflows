export const meta = {
  name: 'acp-build-phase1-freeze',
  description: 'Freeze the AgentRunner interface + shared types and scaffold the 4-package workspace',
  phases: [
    { title: 'Design', detail: '3 independent contract+scaffold designs (diverse priorities)' },
    { title: 'Synthesize', detail: 'score the candidates and merge the winning contract' },
    { title: 'Materialize', detail: 'write the scaffold, compile, git-commit, emit handoff' },
  ],
}

// ── durable paths (session-independent) ──
const REPO = '/home/vikash/agentprism-workflows'
const ORCH = `${REPO}/.orchestration`
const GT = `${ORCH}/ground-truth.json` // Phase-0 reads + a `corrections` overlay — corrections WIN over findings/readiness
const README = `${REPO}/README.md`
const PI = '/home/vikash/pi-dynamic-workflows/src' // lifted engine source @1b0291ab

const CANDIDATE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['label', 'agentRunnerInterfaceTs', 'sharedTypesTs', 'packageLayout', 'mcpToolInputTs', 'workflowRunResultTs', 'keyDecisions'],
  properties: {
    label: { type: 'string' },
    agentRunnerInterfaceTs: { type: 'string', description: 'the AgentRunner TS interface, as source' },
    sharedTypesTs: { type: 'string', description: 'RunOptions/AgentResult/AgentUsage/AgentHistoryEntry/WorkflowRunResult, as source' },
    packageLayout: { type: 'string', description: 'tree of the 4-package pnpm workspace + key config files' },
    mcpToolInputTs: { type: 'string', description: 'the workflow MCP tool input type' },
    workflowRunResultTs: { type: 'string' },
    keyDecisions: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['decision', 'choice'], properties: { decision: { type: 'string' }, choice: { type: 'string' } } } },
    risks: { type: 'array', items: { type: 'string' } },
  },
}

const FROZEN_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['agentRunnerInterfaceTs', 'sharedTypesTs', 'packageLayout', 'mcpToolInputTs', 'workflowRunResultTs', 'keyDecisions', 'chosenFrom', 'mergeNotes'],
  properties: {
    agentRunnerInterfaceTs: { type: 'string' },
    sharedTypesTs: { type: 'string' },
    packageLayout: { type: 'string' },
    mcpToolInputTs: { type: 'string' },
    workflowRunResultTs: { type: 'string' },
    keyDecisions: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['decision', 'choice'], properties: { decision: { type: 'string' }, choice: { type: 'string' } } } },
    chosenFrom: { type: 'string' },
    mergeNotes: { type: 'string' },
  },
}

const MATERIALIZE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['scaffoldCommitSha', 'packageManifest', 'installOk', 'buildOk', 'handoffPath', 'notesForPhase2'],
  properties: {
    scaffoldCommitSha: { type: 'string' },
    packageManifest: { type: 'array', items: { type: 'string' } },
    installOk: { type: 'boolean' },
    buildOk: { type: 'boolean' },
    handoffPath: { type: 'string' },
    notesForPhase2: { type: 'string' },
  },
}

const PRIORITIES = [
  { label: 'fidelity', angle: 'Pi-seam fidelity FIRST: the frozen interface must match the engine call site (workflow.ts:465) EXACTLY — raw return value (string | Static<schema>), onUsage out-of-band, throw WorkflowError{code,recoverable}, engine owns timeout/abort, typebox schema hashed into resume identity. Minimize churn to the lifted engine.' },
  { label: 'dx', angle: 'Developer-experience FIRST: cleanest shared-types package and the most ergonomic single run(prompt,opts) for both backends, while still honoring the engine seam. Make the acp-agents <-> engine boundary obvious.' },
  { label: 'acp-fit', angle: 'ACP/forward-compat FIRST: shape the runner + shared types so the Claude path (_meta.claudeCode.options.outputFormat + emitRawSDKMessages, read off raw _claude/sdkMessage) and the Codex path (turn outputSchema via patched adapter + OpenAI-strict normalize, read off normal stream) sit cleanly behind ONE run(prompt,{schema}). Tolerate usage===undefined (ACP usage is experimental).' },
]

phase('Design')
log('Phase 1: 3 independent contract+scaffold designs against the frozen ground truth')
const candidates = (await parallel(PRIORITIES.map(p => () =>
  agent(
    `Design the FROZEN contract for the Pi-independent ACP+MCP workflow orchestrator. READ: ${README} (the system) and ${GT} (verified Phase-0 ground truth — its top-level "corrections" block WINS over "findings"/"readiness" on any conflict; pay attention to .readiness.agentRunnerInterfaceInputs and .sharedTypeInputs). The engine seam is NON-NEGOTIABLE — cross-check against ${PI}/agent.ts (AgentRunOptions/AgentUsage/AgentRunResult) and ${PI}/workflow.ts (the single run() call site). Produce a COMPLETE candidate: (1) the AgentRunner TS interface; (2) the shared-types module (RunOptions/AgentResult/AgentUsage/AgentHistoryEntry + WorkflowRunResult); (3) the 4-package pnpm workspace layout — packages: shared-types, acp-agents, workflow-engine, mcp-server, with acp-agents and workflow-engine NOT importing each other (only shared-types); (4) the MCP "workflow" tool input type; (5) the WorkflowRunResult output type. Constraints: keep typebox at the seam (hashed into resume), make options.agent REQUIRED, MCP numeric bounds CLAMP not reject, reserve the _meta namespace "agentprism/*". DESIGN ANGLE: ${p.angle}`,
    { label: `design:${p.label}`, phase: 'Design', schema: CANDIDATE_SCHEMA }
  )
))).filter(Boolean)
log(`Phase 1: ${candidates.length}/3 candidates`)

phase('Synthesize')
const frozen = await agent(
  `Score these ${candidates.length} contract candidates against the Phase-0 ground truth (${GT}; corrections WIN) and the engine seam, then SYNTHESIZE the single winning frozen contract — take the strongest interface and graft the best ideas from the others. The result MUST: match the engine call at workflow.ts:465 (raw return, onUsage out-of-band, thrown WorkflowError{code,recoverable}, engine-owned timeout/abort, JSON-round-trippable result); keep typebox; make options.agent required; define shared-types (RunOptions/AgentResult/AgentUsage/AgentHistoryEntry/WorkflowRunResult); the MCP workflow tool input (script required; maxAgents/concurrency/agentRetries/agentTimeoutMs/tokenBudget/resumeFromRunId optional; bounds CLAMPED not rejected — plain numbers, engine clamps); and a minimal MCP outputSchema pinning WorkflowRunResult{runId,status,result,tokenUsage,logs?}. CANDIDATES:\n${JSON.stringify(candidates)}`,
  { label: 'synthesize', phase: 'Synthesize', schema: FROZEN_SCHEMA }
)

phase('Materialize')
const built = await agent(
  `Materialize the FROZEN contract into the repo at ${REPO}. Create a pnpm workspace with 4 packages under packages/: shared-types (the frozen AgentRunner interface + shared types — the ONLY thing both siblings import), acp-agents, workflow-engine, mcp-server. Each gets a package.json with correct deps (acp-agents and workflow-engine depend on shared-types but NOT on each other; mcp-server depends on all three). Add root package.json + pnpm-workspace.yaml + a base tsconfig + per-package tsconfig. Write the shared-types source VERBATIM from the frozen contract. Add minimal stub index.ts exports for the three other packages so the workspace type-checks. Then run \`pnpm install\` and \`pnpm -r exec tsc --noEmit\` and FIX until clean. Git: stage all and commit on the current branch with message "scaffold: freeze AgentRunner contract + 4-package workspace". Finally WRITE the handoff file ${ORCH}/phase1-contract.json = {frozenContract, scaffoldCommitSha, packageManifest, buildOk, notesForPhase2}. FROZEN CONTRACT:\n${JSON.stringify(frozen)}`,
  { label: 'materialize', phase: 'Materialize', schema: MATERIALIZE_SCHEMA }
)

return { frozen, built }
