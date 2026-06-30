export const meta = {
  name: 'acp-build-phase2-implement',
  description: 'Implement the 3 modules in parallel, each in its own self-managed git worktree off the frozen scaffold',
  phases: [
    { title: 'Prepare', detail: 'create 3 git worktrees off the scaffold commit, one branch per module' },
    { title: 'Implement', detail: 'workflow-engine port + acp-agents + mcp-server, each isolated in its worktree' },
    { title: 'Record', detail: 'persist the phase-2 handoff and confirm the branches/commits exist' },
  ],
}

const REPO = '/home/vikash/agentprism-workflows'
const ORCH = `${REPO}/.orchestration`
const GT = `${ORCH}/ground-truth.json` // corrections WIN
const P1 = `${ORCH}/phase1-contract.json` // frozen contract + scaffoldCommitSha (written by Phase 1)
const PI = '/home/vikash/pi-dynamic-workflows/src'
const CACP = `${ORCH}/sources/claude-agent-acp` // @b8df8e0e
const CODEX = `${ORCH}/sources/codex-acp` // @5506fbae
const ACP_SDK = `${ORCH}/sdks/agentclientprotocol-sdk-1.0.0/package`
const CAS = `${ORCH}/sdks/anthropic-ai-claude-agent-sdk-0.3.195/package`
const MCP_SDK = `${ORCH}/sdks/modelcontextprotocol-sdk-1.29.0/package`
// worktrees live OUTSIDE the repo (avoids the "worktree inside working tree" caveat); branches live in the shared .git
const WT = '/home/vikash/agentprism-worktrees'

// shared rule for every implementer so the three branches merge cleanly in Phase 3
const ISOLATION_RULES = (mod) =>
  `Operate ENTIRELY inside the pre-created worktree at ${WT}/${mod} — use \`git -C ${WT}/${mod}\` for ALL git ops and edit files under ${WT}/${mod}/packages/${mod}. You are on branch phase2/${mod} (already checked out off the scaffold commit). HARD RULES so the branches merge conflict-free: (a) modify files ONLY under packages/${mod}/ — never touch root package.json, pnpm-workspace.yaml, base tsconfig, or any other package; (b) put your dependencies in packages/${mod}/package.json ONLY; (c) you MAY run \`pnpm install\` in the worktree to typecheck, but DO NOT \`git add\` or commit pnpm-lock.yaml or any root file — Phase 3 regenerates the lockfile once after merging; (d) commit ONLY your packages/${mod}/ changes to branch phase2/${mod}, then report the exact commit SHA. DEFINITION OF DONE (strict, non-negotiable): Fully implement everything the frozen contract, this module's spec, and the ground-truth corrections require — complete and working in ONE pass. ZERO TODO / FIXME / XXX / 'follow-up' / 'for now' / 'later phase' / placeholder comments or markers. ZERO stubbed or empty function bodies, no 'throw new Error(not implemented)', no placeholder return values for agreed behavior. Do NOT use 'as any', @ts-ignore, or @ts-expect-error to hide unfinished work (the ONE permitted 'as any' is the documented engine seam cast at the agentRunner.run call); tscOk must be genuinely true. If — and ONLY if — you hit something GENUINELY ambiguous or not covered by the README / ground-truth corrections / frozen contract: STOP, finish everything else completely, and record a precise question in gapsLeft. Never silently guess; never defer agreed work with a TODO. gapsLeft is exclusively for escalating un-agreed ambiguities — it is NOT a backlog.`

const PREP_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['baseSha', 'worktrees'],
  properties: {
    baseSha: { type: 'string' },
    worktrees: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['module', 'path', 'branch'], properties: { module: { type: 'string' }, path: { type: 'string' }, branch: { type: 'string' } } } },
  },
}

const MODULE_RESULT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['module', 'worktreePath', 'branch', 'commitSha', 'filesWritten', 'tscOk', 'gapsLeft'],
  properties: {
    module: { type: 'string' },
    worktreePath: { type: 'string' },
    branch: { type: 'string' },
    commitSha: { type: 'string' },
    filesWritten: { type: 'array', items: { type: 'string' } },
    tscOk: { type: 'boolean' },
    testsOk: { type: 'boolean' },
    gapsLeft: { type: 'array', items: { type: 'string' } },
    handoffNotes: { type: 'string' },
  },
}

const RECORD_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['wrote', 'branchesPresent', 'missing'],
  properties: {
    wrote: { type: 'boolean' },
    branchesPresent: { type: 'array', items: { type: 'string' } },
    missing: { type: 'array', items: { type: 'string' } },
  },
}

phase('Prepare')
log('Phase 2: creating 3 worktrees off the scaffold commit (one branch per module)')
const prep = await agent(
  `Read ${P1} and take its scaffoldCommitSha as the base. In the main repo at ${REPO}, ensure that commit is HEAD's ancestor, then create three SELF-MANAGED git worktrees off that exact SHA, each on a fresh branch, OUTSIDE the repo under ${WT}:\n` +
  `  mkdir -p ${WT}\n` +
  `  for m in workflow-engine acp-agents mcp-server; do\n` +
  `    git -C ${REPO} worktree remove --force ${WT}/$m 2>/dev/null || true\n` +
  `    git -C ${REPO} branch -D phase2/$m 2>/dev/null || true\n` +
  `    git -C ${REPO} worktree add -b phase2/$m ${WT}/$m <scaffoldCommitSha>\n` +
  `  done\n` +
  `Each worktree shares the main repo's object store and refs, so its phase2/<module> branch is visible/mergeable from ${REPO}. Verify all three exist (\`git -C ${REPO} worktree list\` and \`git -C ${REPO} branch --list 'phase2/*'\`) and report baseSha + the three {module,path,branch}.`,
  { label: 'prepare', phase: 'Prepare', schema: PREP_SCHEMA }
)
log(`Phase 2: worktrees ready off ${prep.baseSha?.slice(0, 8)} — ${prep.worktrees.map(w => w.branch).join(', ')}`)

phase('Implement')
log('Phase 2: 3 module implementers, each isolated in its own worktree')
const built = (await parallel([
  // ── workflow-engine: a PORT, not a rewrite ──
  () => agent(
    `PORT pi-dynamic-workflows into packages/workflow-engine. ${ISOLATION_RULES('workflow-engine')}\nRead the frozen contract ${P1}; import AgentRunner + shared types from packages/shared-types (do NOT redefine them). LIFT these files from ${PI} nearly verbatim, changing ONLY Pi-coupling: workflow.ts (vm realm, DETERMINISM_PRELUDE, the agent() global, parallel barrier, pipeline — KEEP the cross-item Promise.all join at the :588 equivalent, createLimiter, journal hashAgentCall/firstMiss longest-unchanged-prefix, budget, per-phase sub-budgets), run-persistence.ts, workflow-manager.ts, worktree.ts (the ENGINE's own product worktree feature — keep it), model-routing.ts, model-tier-config.ts. De-Pi-ify: drop @earendil-works/pi-coding-agent imports; make options.agent REQUIRED (delete the "?? new WorkflowAgent" default); the ONLY runner call is agentRunner.run(prompt, opts) at the lifted workflow.ts:465 equivalent. Source the model list from ACP configOptions instead of agent.ts listAvailableModelSpecs. Parameterize the hardcoded .pi/agents dir WITHOUT changing agentDefinitionKey serialization. hashAgentCall's JSON.stringify output MUST stay byte-identical to pi (resume compatibility). The engine must NOT import acp-agents. Run \`pnpm install\` + \`tsc --noEmit\` in the worktree; commit; report. Ground truth: ${GT} (corrections WIN).`,
    { label: 'engine', phase: 'Implement', schema: MODULE_RESULT_SCHEMA }
  ),
  // ── acp-agents: the genuinely fresh leaf ──
  () => agent(
    `Implement packages/acp-agents (the AgentRunner leaf — ACP client + Claude/Codex backends). ${ISOLATION_RULES('acp-agents')}\nRead frozen contract ${P1}; import AgentRunner + shared types from packages/shared-types. BUILD IN ORDER: (1) ACP client over stdio using @agentclientprotocol/sdk@1.0.0 — read ${ACP_SDK}/dist/acp.d.ts (Client/Agent interfaces + ClientSideConnection live HERE, not connection.d.ts) and dist/schema/types.gen.d.ts. Implement initialize (send a BENIGN clientInfo — NOT JetBrains/IntelliJ 2026.1, so Codex config options stay enabled), session/new, session/prompt, drain session/update (agent_message_chunk -> text, tool_call/request_permission -> allow/deny policy, usage_update -> onUsage), session/cancel on opts.signal. (2) ClaudeBackend: spawn claude-agent-acp; set schema at session/new via _meta.claudeCode.options.outputFormat:{type:'json_schema',schema} + emitRawSDKMessages:true; read structured_output off the raw _claude/sdkMessage carrying type:"result",subtype:"success" (see ${CACP}/src/acp-agent.ts and ${CAS}/sdk.d.ts). (3) CodexBackend: VENDOR codex-acp from ${CODEX} into packages/acp-agents/vendor/codex-acp and apply the ~1-line patch in src/CodexAcpClient.ts sendPrompt() -> the runTurn({...}) call: add \`outputSchema: (request._meta as any)?.["agentprism/outputSchema"] ?? null\`; send the schema via _meta "agentprism/outputSchema"; NORMALIZE the typebox/JSON schema to OpenAI STRICT rules (every property required, additionalProperties:false, supported types/keywords only) BEFORE sending; read the FINAL assistant message text off the normal stream and JSON.parse it. (4) run(prompt,opts): pick backend by model/agentType; session/new {cwd}; select model via session/set_config_option; apply schema per backend; prompt; enforce permission allow/deny; accumulate usage -> onUsage on BOTH success and error; map stopReason -> return value or thrown WorkflowError{code,recoverable}. LADDER: native constraint -> client-side validate -> re-prompt (PORT resolveStructuredOutput + extractValidated from ${PI}/agent.ts as the guard). \`pnpm install\` + \`tsc --noEmit\`; commit; report. Ground truth ${GT} (corrections WIN — esp. the Codex item).`,
    { label: 'acp-agents', phase: 'Implement', schema: MODULE_RESULT_SCHEMA }
  ),
  // ── mcp-server: the shell / composition root ──
  () => agent(
    `Implement packages/mcp-server (the shell). ${ISOLATION_RULES('mcp-server')}\nRead frozen contract ${P1}. Using @modelcontextprotocol/sdk (read ${MCP_SDK}/dist/esm/server/mcp.* and the stdio transport): construct McpServer; register the "workflow" tool with the frozen input schema (script required; maxAgents/concurrency/agentRetries/agentTimeoutMs/tokenBudget/resumeFromRunId optional; numeric bounds as PLAIN numbers — engine clamps, do NOT Zod .max()); declare the minimal outputSchema pinning WorkflowRunResult. Handler is SYNCHRONOUS: call the engine runWorkflow to completion, thread extra.signal as the AbortSignal, map the engine onProgress callback -> extra.sendNotification({method:'notifications/progress',...}) (skip if the client sent no _meta.progressToken), return CallToolResult {structuredContent: WorkflowRunResult, content:[human text]}. Expose resumeFromRunId -> engine resumeJournal. checkpoint(): if the host advertises elicitation.form, wire to server.elicitInput; else CATCH the elicitInput throw and apply the headless default (default ?? true). Compose: wire an acp-agents AgentRunner into the engine via DI (the one place all three packages meet). connect StdioServerTransport. \`pnpm install\` + \`tsc --noEmit\`; commit; report. NOTE: this imports BOTH siblings — they exist as workspace stubs in the scaffold, so code against the frozen shared-types interfaces and let Phase 3 reconcile against the real implementations.`,
    { label: 'mcp-server', phase: 'Implement', schema: MODULE_RESULT_SCHEMA }
  ),
])).filter(Boolean)
log(`Phase 2: ${built.length}/3 modules implemented`)

phase('Record')
const record = await agent(
  `Write the file ${ORCH}/phase2-modules.json containing this JSON verbatim (it is the merge contract Phase 3 consumes — each module's branch + commitSha + worktreePath):\n${JSON.stringify({ baseSha: prep.baseSha, modules: built })}\nThen confirm from the MAIN repo (${REPO}) that each commit is reachable: for each module run \`git -C ${REPO} cat-file -t <commitSha>\` and \`git -C ${REPO} branch --list phase2/<module>\`. Report branchesPresent and any missing (Phase 3 needs the commit reachable in the main repo's object store to merge it).`,
  { label: 'record', phase: 'Record', schema: RECORD_SCHEMA }
)

return { prep, built, record }
