# MCP automatic default backend selection (superseded)

**Status:** Superseded in full by [explicit agent routing](explicit-agent-routing.md).

MCP requires an effective model on every actual agent call for every client. It neither opens
agent-configuration setup nor automatically chooses a backend. Backend-only routes explicitly
retain that backend's default model. Backend approval, checkpoints, and live permissions remain
separate supported interactions. Format-3 immutable routing admission replaces positional selections;
older admissions are inspectable but cannot execute. The SDK non-strict runner fallback is unchanged.

## Historical source request

> In practice, users never set AGENTPRISM_DEFAULT_BACKEND, so claude always gets selected when their agent that calls the workflows tool omits a selection in agent calls. I think we should be choosing a default backend in the MCP server intelligently by probing available backends first. But my question to you is if our probeHarnessConfig function accounts for authentication status. If it does then we should choose the first available backend, if not we'll need to discuss what to do
>
> Got it. Lets go with your recommendation.
