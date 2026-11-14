import { DomainError } from "../contracts/common.ts";

const booleanOptions = new Set(["json", "help"]);
const valueOptions = new Set([
  "workspace",
  "agent-dir",
  "definitions",
  "bootstrap",
  "cursor",
  "since",
  "palette",
]);
const removedCommands = new Set([
  "run",
  "serve",
  "attach",
  "request",
  "execute",
  "wait",
  "recover",
  "background",
  "steer",
  "follow-up",
  "continue",
  "cancel",
  "apply",
  "rollback",
  "reconcile",
]);
const savedCommands = new Set([
  "view",
  "status",
  "logs",
  "query",
  "result",
  "conversation",
  "changes",
]);

export type CliArguments = {
  command: string;
  positional: string[];
  flags: Set<string>;
  options: Map<string, string>;
  definitions: string[];
};

export function parseArguments(argv: readonly string[]): CliArguments {
  const result: CliArguments = {
    command: "help",
    positional: [],
    flags: new Set(),
    options: new Map(),
    definitions: [],
  };
  let commandFound = false;
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === "--") {
      result.positional.push(...argv.slice(index + 1));
      break;
    }
    if (!value.startsWith("--")) {
      if (!commandFound) {
        result.command = value;
        commandFound = true;
      } else result.positional.push(value);
      continue;
    }
    const option = value.slice(2);
    if (booleanOptions.has(option)) {
      if (result.flags.has(option))
        throw new DomainError("invalid_input", `Use --${option} only once`);
      result.flags.add(option);
      continue;
    }
    if (!valueOptions.has(option))
      throw new DomainError("invalid_input", `Unknown option ${value}`);
    const supplied = argv[++index];
    if (!supplied || supplied.startsWith("--"))
      throw new DomainError("invalid_input", `${value} requires a value`);
    if (option === "definitions") result.definitions.push(supplied);
    else {
      if (result.options.has(option))
        throw new DomainError("invalid_input", `Use ${value} only once`);
      result.options.set(option, supplied);
    }
  }
  if (result.flags.has("help")) result.command = "help";
  if (removedCommands.has(result.command))
    throw new DomainError(
      "unsupported",
      `${result.command} was removed. Operate fleets through Pi tools, pi.events RPC, or an embedded host; use view/status to inspect saved runs.`,
    );
  if (
    !["help", "schema", "tools", "agents"].includes(result.command) &&
    !savedCommands.has(result.command)
  )
    throw new DomainError("invalid_input", `Unknown command ${result.command}`);
  return result;
}

export function requireArgument(args: CliArguments, index: number, name: string): string {
  const value = args.positional[index];
  if (!value) throw new DomainError("invalid_input", `${args.command} requires ${name}`);
  return value;
}

export const usage = `Usage:
  pinata view <run-directory> [--palette name]    browse a saved run
  pinata query <run-directory> <query.json|->     query retained data
  pinata status|logs <run-directory> [--json]      inspect retained state or events
  pinata result|conversation|changes <run-directory> <worker> [assignment]
  pinata schema [name] --json                     generated canonical JSON Schema
  pinata agents [list|show <name>|validate]        discover agent definitions
  pinata tools --json                            discover coordinator tool schemas

Discovery options: --workspace, --agent-dir, --definitions (repeatable), --bootstrap.
Inspection options: --since <revision>, --cursor <cursor>, --palette <name>, --json.
The CLI reads saved data. Operate fleets through Pi tools, pi.events RPC, or an
embedded host. Recovery and application require an owning runtime.
Exit codes: 0 observed, 1 application failed/uncertain, 2 invalid or rejected request.
Execution completion does not certify correctness.`;
