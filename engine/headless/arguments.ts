import { DomainError } from "../contracts/common.ts";

const booleanOptions = new Set([
  "json",
  "watch",
  "control",
  "saved",
  "import",
  "dry-run",
  "next",
  "help",
]);
const valueOptions = new Set([
  "directory",
  "workspace",
  "run",
  "agent-dir",
  "definitions",
  "factory",
  "config",
  "grants",
  "bootstrap",
  "model",
  "thinking",
  "request-id",
  "cursor",
  "destination",
  "operation",
  "owner",
  "scope",
  "worker",
  "assignment",
  "output",
  "kind",
  "since",
  "palette",
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
  if (result.flags.has("saved") && result.flags.has("control"))
    throw new DomainError("invalid_input", "Saved sources cannot grant control");
  if (result.flags.has("import") && result.flags.has("dry-run"))
    throw new DomainError("invalid_input", "Choose --import or --dry-run");
  return result;
}

export function requireArgument(args: CliArguments, index: number, name: string): string {
  const value = args.positional[index];
  if (!value) throw new DomainError("invalid_input", `${args.command} requires ${name}`);
  return value;
}

export const usage = `Usage:
  pinata run <job.json|-> [--json] [--watch]       run a finite schema-4 job
  pinata serve [job.json] [--directory <run>]     own a runtime and serve authenticated control
  pinata attach <run-directory> [--watch]         browse in a terminal; otherwise print status
  pinata view <run-directory> [--control] [--palette name]  open the live/saved viewer
  pinata request <run-directory> <request.json|-> [--control]
  pinata execute <run-directory> <envelope.json|->
  pinata query <run-directory> <query.json|->
  pinata status|logs <run-directory> [--watch] [--json]
  pinata result|conversation|changes <run-directory> <worker> [assignment]
  pinata wait <run-directory> [worker ...] [--next]
  pinata steer|follow-up|continue <run-directory> <worker> <message>
  pinata cancel <run-directory> [--scope assignment|worker|run] [--worker id] [--assignment n]
  pinata background|recover <run-directory>
  pinata apply <run-directory> <worker> <assignment> --destination <checkout>
  pinata rollback <run-directory> <operation> --destination <checkout>
  pinata reconcile <run-directory> <operation> --owner <epoch>
  pinata schema [name] --json                    generated canonical JSON Schema
  pinata agents [list|show <name>|validate]        discover Markdown definitions
  pinata tools --json                            discover coordinator tool schemas
  pinata migrate <input> [--kind job|config|definition] [--output <new-file>]
  pinata migrate-run <legacy-directory> --workspace <checkout> [--run <new-id>]
      [--dry-run | --import --directory <new-store>] [--output <new-manifest>]

Host options: --workspace, --directory, --run, --agent-dir, --definitions (repeatable),
--config <json>, --grants <json>, --model <provider/id>, --thinking <level>, --bootstrap <module>.
--factory <module> selects a trusted development host factory exporting openHost.
Control commands attach to a live owning server. Saved runs remain read-only; start
serve explicitly to claim one. Aborting an attached wait leaves work running.
Exit codes: 0 completed/observed, 1 execution or application failed/uncertain,
2 invalid or rejected request, 3 cancelled. Completion does not certify correctness.`;
