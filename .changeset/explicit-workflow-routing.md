---
"@automatalabs/workflow-engine": major
"@automatalabs/workflows": major
"@automatalabs/shared-types": minor
---

Require actual effective model routes for strict workflows and remove positional host-selected agent configuration maps. Authored routes, modes, and options remain authoritative for branching and concurrent calls, including calls that mock validation did not observe. Aggregator browse selectors cannot dispatch agents.

Replace format-2 routing admissions with format 3, snapshot named-agent definitions and tier settings for same-run continuation, and record effective optional configuration beside each actual call identity. Old positional admissions remain inspectable but cannot continue or seed execution. Hosts may enrich missing-route errors with discovery diagnostics without choosing a route. The SDK's non-strict default routing remains available.
