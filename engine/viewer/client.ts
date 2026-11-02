// Socket and log adapters expose the same conversations to both workspace entry points.
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { RunView } from "../core/view.ts";
import { readJsonl } from "../core/store.ts";
import { IpcClient, type Update } from "../ipc/client.ts";
import { LogClient } from "../sources/log.ts";
import { focusWorkspace, type PaneResource } from "../herdr/client.ts";
import type { DetailSource } from "../ui/detail.ts";

export interface ViewerClient {
  readonly source: "socket" | "log";
  view: RunView | null;
  theme: string | null;
  closed: boolean;
  on(listener: (update: Update) => void): () => void;
  messages(
    agent: string,
  ): Promise<{ messages: unknown[]; streaming?: { text: string; thinking: string } }>;
  steer(agent: string, text: string, as: "steer" | "followUp"): void;
  close(): void;
}

const links = new WeakMap<ViewerClient, string | null>();
async function linkStamp(dir: string): Promise<string | null> {
  const info = await stat(join(dir, "link.json")).catch(() => null);
  return info ? `${info.mtimeMs}:${info.size}` : null;
}

export async function connectViewer(dir: string): Promise<ViewerClient> {
  const stamp = await linkStamp(dir);
  if (stamp) {
    try {
      return await IpcClient.connect(dir);
    } catch {
      /* A stale socket still has a readable log. */
    }
  }
  const client = await LogClient.open(dir, { follow: true });
  links.set(client, stamp);
  return client;
}

// Retry when a socket appears or is replaced, without resetting a log view every poll
// because of the same stale link. A lost live connection falls back to recorded output.
export async function reconnectViewer(client: ViewerClient, dir: string): Promise<boolean> {
  if (client.source === "socket") return client.closed;
  const stamp = await linkStamp(dir);
  return !!stamp && stamp !== links.get(client);
}

export function clientDetail(client: ViewerClient, dir: string, cwd: string): DetailSource {
  return {
    run: client.view!.run,
    cwd,
    agents: () => client.view?.order ?? [],
    view: (agent) => client.view?.agents[agent],
    load: (agent) =>
      client.closed
        ? readJsonl(join(dir, "transcripts", `${agent}.jsonl`)).then((messages) => ({ messages }))
        : client.messages(agent),
    subscribe: (agent, onEvent) =>
      client.on((update) => {
        if (update.kind === "events")
          for (const event of update.events) if (event.agent === agent) onEvent(event);
      }),
    ...(client.source === "socket" && {
      steer: async (agent: string, text: string, as: "steer" | "followUp") => {
        if (client.closed) throw new Error("The viewer is disconnected");
        client.steer(agent, text, as);
      },
    }),
    openPane: async (agent) =>
      focusWorkspace(
        JSON.parse(await readFile(join(dir, "agents", agent, "pane.json"), "utf8")) as PaneResource,
      ),
  };
}
