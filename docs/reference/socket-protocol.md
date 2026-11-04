# Socket protocol

Use this protocol to build a viewer that follows a run and sends steering messages.
For the existing viewer, see [watching agents](../tutorials/watching-agents.md).

The socket starts with an observe-mode run or `/pinata view --external`. It stops
once the run has finished and the last viewer has left.

## Finding it

`<run>/link.json` (mode 0600) holds `{v, run, socket, token, pid}`. The socket is
`<run>/pinata.sock` (a Unix domain socket in a 0700 directory), or a private temporary
directory when that path would be too long, or a named pipe `\\.\pipe\pinata-<run>-<random>`
on Windows.

## Frames

Frames are JSON objects, one per line. Send a valid `hello` for the run within
five seconds of connecting; otherwise the server closes the connection.

Client → server:

| Frame                                               | Meaning                         |
| --------------------------------------------------- | ------------------------------- |
| `{type: "hello", v: 1, token, role: "viewer", run}` | Authenticate                    |
| `{type: "ack", seq}`                                | Applied every event up to `seq` |
| `{type: "messages", agent}`                         | Request an agent's conversation |
| `{type: "steer", agent, text, as}`                  | Steer or queue a follow-up      |
| `{type: "abort", agent}`                            | Cancel an agent                 |

Server → client:

| Frame                                             | Meaning                                            |
| ------------------------------------------------- | -------------------------------------------------- |
| `{type: "welcome", v: 1, theme, runs}`            | After a valid hello; `theme` is the parent Pi's    |
| `{type: "snapshot", run, view}`                   | The run's whole view; follow-on events apply to it |
| `{type: "events", events}`                        | New events, batched at most every 50 ms            |
| `{type: "messages", agent, messages, streaming?}` | An agent's conversation (Pi messages)              |
| `{type: "error", message}`                        | A refused frame or command                         |

## Catching up

When a client falls more than 1,000 events behind its last `ack`, the server sends
a fresh `snapshot` instead of replaying the backlog. The existing `pinata view`
client is implemented in `engine/ipc/client.ts`.
