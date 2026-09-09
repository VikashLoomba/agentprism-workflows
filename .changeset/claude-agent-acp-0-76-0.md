---
"@automatalabs/acp-agents": patch
---

Refresh `@agentclientprotocol/claude-agent-acp` to 0.76.0 and its wrapped Claude Agent SDK runtime to 0.3.267 (workspace override). The adapter now advertises the AIR recommended-config-value extension to clients that opt in; AgentPrism does not opt in, so no recommendation hint is received and explicit model routing is unchanged. The runtime records custom system prompts by default; AgentPrism folds instructions into the prompt text and never drives `systemPrompt`, so behavior is unchanged.
