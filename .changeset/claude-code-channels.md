---
"@automatalabs/mcp-server": minor
---

Claude Code channels: the run monitor's automatic updates, delivered without a panel.

- The server declares the `claude/channel` capability and sends `notifications/claude/channel` for terminal outcomes, pauses, checkpoints, pending permissions, and pending setup requests — the same messages, ids, and wording the MCP Apps run monitor injects into a host conversation.
- A session receives updates only for the runs its own `run`, `resume`, or `status` calls named. Other clients of the shared daemon never see them. A restarted Claude Code session re-attaches by inspecting the run.
- Claude Code reads them when launched with `--dangerously-load-development-channels server:<name>` during the channels research preview; hosts without a channel handler drop the notification.
