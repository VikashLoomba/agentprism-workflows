---
"@automatalabs/mcp-server": patch
---

Remove speculative default-backend discovery for unvisited agent calls and dynamically assembled options that already resolve a model. MCP admission now selects defaults only for observed calls that need them, avoiding unnecessary probes and rejection when an unused default backend is unavailable. Strict canonical coverage still rejects extra live occurrences before dispatch.
