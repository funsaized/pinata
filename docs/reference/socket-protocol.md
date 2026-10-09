# Socket protocol

A run's socket lets viewers follow it (`pinata view`). It starts with an observe-mode run or
on `/pinata watch`, and stops when the run has settled and the last viewer leaves.

## Finding it

`<run>/link.json` (mode 0600) holds `{v, run, socket, token, pid}`. The socket is
`<run>/pinata.sock` (a Unix domain socket in a 0700 directory), or a private temporary
directory when that path would be too long, or a named pipe `\\.\pipe\pinata-<run>-<random>`
on Windows.

## Frames

JSON lines. The first client frame must be a valid `hello` for the run within 5 seconds, or
the connection is closed.

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

A client more than 1,000 events behind its last `ack` gets a fresh `snapshot` instead of the
backlog. `pinata view` uses `engine/ipc/client.ts`.
