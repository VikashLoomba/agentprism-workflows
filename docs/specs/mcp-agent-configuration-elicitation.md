# MCP agent configuration setup (superseded)

**Status:** Superseded in full by [explicit agent routing](explicit-agent-routing.md).

MCP requires an effective model on every actual agent call for every client. It neither opens
agent-configuration setup nor automatically chooses a backend. Backend-only routes explicitly
retain that backend's default model. Backend approval, checkpoints, and live permissions remain
separate supported interactions. Format-3 immutable routing admission replaces positional selections;
older admissions are inspectable but cannot execute. The SDK non-strict runner fallback is unchanged.

## Historical source request

> Implement MCP elicitation before workflow execution so users can choose provider, model, and advertised configuration for each `agent()` call in one structured request. Include each call’s phase title and description. Support both legacy MCP clients advertising elicitation and modern 2026-07-28 clients using the repository’s dual-era SDK migration approach.
> When using the MCP server, the agent authoring and running the workflow with the workflows tool starts the workflow with defined provider/model configuration, but for some reason the server is still sending elicitation requests. We're only supposed to be sending elicitation requests when the agent tries to use the workflows tool with a script that doesn't define some required configuration.
