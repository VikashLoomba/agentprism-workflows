---
"@automatalabs/acp-agents": patch
---

Custom backends: embed the JSON Schema in the prompt text on schema runs. Found by a live e2e against opencode's ACP server: an agent that ignores the `_meta.outputSchema` forward returned well-formed JSON with invented keys, and the repair ladder can never converge on a contract the model was never shown. Custom backends now state the schema in the final-output contract (belt-and-braces: the meta forward for agents that honor it, the prompt for agents that don't). Built-in Claude/Codex backends are unchanged — their native constraint channel is authoritative.
