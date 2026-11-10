import type { DefinitionSummary, LaunchInfo } from "../contracts/index.ts";

type DelegationAvailability =
  | { enabled: false; reason: string }
  | {
      enabled: true;
      maxDepth: number;
      access: "read" | "write";
      agents: string[];
      tools: string[];
      workspaces: string[];
    };

// Planning hints from the current discovery snapshot, not new authority or a
// promise of model availability. Acceptance still validates the complete launch.
export function delegationAvailability(
  definitions: DefinitionSummary[],
  launch?: LaunchInfo,
): Map<string, DelegationAvailability> {
  const discovered = new Set(definitions.map(({ definition }) => definition.name));
  const allowed = new Set(launch?.grants.delegation.agents ?? []);
  const capabilities = launch?.backends[launch.backend];
  const workspaces =
    launch?.grants.delegation.workspaces.filter((workspace) =>
      launch.grants.workspaces.includes(workspace),
    ) ?? [];
  return new Map(
    definitions.map(({ definition }) => {
      const disabled = (reason: string): [string, DelegationAvailability] => [
        definition.name,
        { enabled: false, reason },
      ];
      if (!definition.pinata.delegation.maxDepth)
        return disabled("Definition has child delegation disabled");
      if (!launch) return disabled("Host launch capabilities are unavailable");
      if (!launch.grants.delegation.maxDepth) return disabled("Host has child delegation disabled");
      if (definition.pinata.delegation.maxDepth > launch.grants.delegation.maxDepth)
        return disabled("Definition depth exceeds the host grant");
      if (!capabilities?.available || !capabilities.delegation)
        return disabled("Selected backend cannot launch children");
      if (definition.pinata.access === "write" && launch.grants.access !== "write")
        return disabled("Parent definition requires ungranted write access");
      if (definition.tools.some((tool) => !launch.grants.tools.includes(tool)))
        return disabled("Parent definition requires ungranted tools");
      const agents = definition.handoffs.filter(
        (name) => allowed.has(name) && discovered.has(name),
      );
      if (!agents.length) return disabled("No discovered handoff definitions are granted");
      if (!workspaces.length) return disabled("No child workspace is granted");
      return [
        definition.name,
        {
          enabled: true,
          maxDepth: definition.pinata.delegation.maxDepth,
          access: definition.pinata.access,
          agents,
          tools: launch.grants.delegation.tools,
          workspaces,
        },
      ];
    }),
  );
}
