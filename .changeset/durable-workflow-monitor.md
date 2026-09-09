---
"@automatalabs/mcp-server": major
"@automatalabs/workflow-engine": major
"@automatalabs/shared-types": major
"@automatalabs/workflows": major
---

Make MCP workflow run and resume operations asynchronous with durable caller request identities, pending setup, explicit setup replies, retry-safe continuation, and bounded lifecycle requests. Open run views through the dedicated workflow_monitor tool, with quiet selection context, required-input/terminal notifications, fullscreen support, explicit controls, and exact-result download.

Every unanswered script-authored checkpoint now pauses until an explicit answer. Remove checkpoint headless/default policies, the MCP background/foreground split, held lifecycle elicitation, and retired schemas without aliases. Persist explicit checkpoint provenance and reject incompatible historical execution while retaining readable history. Keep both supported MCP protocol eras and the public SDK promise and explicit confirm APIs.
