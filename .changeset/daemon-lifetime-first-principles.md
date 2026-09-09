---
"@automatalabs/mcp-server": minor
"@automatalabs/workflows": minor
---

Daemon lifetime: orphaned daemons are no longer possible to create by accident, and none can hide from the CLI.

- **The shim lives exactly as long as its host.** The SDK stdio transport never reacts to EOF, so a host that exited without signalling its shim left it behind holding a live session, which kept the daemon alive forever. The shim now exits on stdin EOF/close and when it is reparented, ending its session first.
- **Supersession is a one-way door.** A superseded daemon stays superseded even when its successor later exits and clears the family pointer; a missing pointer now means "superseded" once a daemon has been published. Before, the vanished pointer put the predecessor back into full service on a random port with no discovery, which is how zombie daemons accumulated.
- **The CLI reconciles records against the OS.** `daemon status` lists, and `daemon stop --all` stops, every `--daemon-run` process of this user even when it has no record on disk (POSIX). A record whose pid the OS has reused is pruned instead of signalled.
- Support for the pre-family `daemon.json` pointer is removed; those daemons predate the current discovery layout and are found through the process table instead.
