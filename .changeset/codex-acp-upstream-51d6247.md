---
"@automatalabs/codex-acp": minor
---

Sync with upstream agentclientprotocol/codex-acp main (non-squashed subtree merge of `51d6247`, upstream release 1.11.0).

- Advertise the AIR recommended-config-value extension: the model and reasoning-effort session config options carry a recommended-value hint for clients that opt in (#491). Additive; clients that do not advertise the capability, including AgentPrism's runner, see no change.
- Simplify GPT model display names in the model picker (`gpt-5.6-sol` renders as "5.6 Sol") (#493). Cosmetic: option values and routing ids are unchanged.
- Bump `@openai/codex` to ^0.153.4.
- Upstream preview-publishing CI (#474) is not adopted; the fork keeps its workflow deletions and releases through root Changesets. The fork-owned `outputSchema` forwarding and AgentPrism ACP extensions were re-verified against the merged `CodexAcpServer` and the fork's 632-test suite.
