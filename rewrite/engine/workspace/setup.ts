import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, open, readdir } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { z } from "zod";
import {
  artifactRefSchema,
  assignmentRefSchema,
  digestSchema,
  identitySchema,
  type ArtifactRef,
  type AssignmentRef,
  DomainError,
} from "../contracts/common.ts";
import {
  cleanupReceiptSchema,
  type ArtifactPort,
  type CleanupReceipt,
} from "../contracts/backend.ts";
import { canonicalJson, digestValue } from "../contracts/digest.ts";
import { configSchema } from "../contracts/config.ts";
import { digestBytes, isMissing, publishImmutable } from "../storage/io.ts";
import { gitCommandResultSchema, gitRequestSchema } from "./git-protocol.ts";
import type { GitReply } from "./git.ts";
import { setupEnvironment, setupShell } from "./setup-environment.ts";

const ecosystems = [
  [
    ["pnpm-lock.yaml", "pnpm", "pnpm install --frozen-lockfile --prefer-offline"],
    ["bun.lock", "bun", "bun install --frozen-lockfile"],
    ["bun.lockb", "bun", "bun install --frozen-lockfile"],
    ["yarn.lock", "yarn", "yarn install --frozen-lockfile"],
    ["package-lock.json", "npm", "npm ci --prefer-offline --no-audit --no-fund"],
    ["npm-shrinkwrap.json", "npm", "npm ci --prefer-offline --no-audit --no-fund"],
  ],
  [
    ["uv.lock", "uv", "uv sync --frozen"],
    ["poetry.lock", "poetry", "poetry install --no-interaction"],
    ["Pipfile.lock", "pipenv", "pipenv sync"],
  ],
] as const;
const inputNames = [
  ...ecosystems.flat().map(([name]) => name),
  "package.json",
  "pyproject.toml",
  "Pipfile",
  ".yarnrc.yml",
];
export const setupSelectionSchema = z.strictObject({
  source: z.enum(["config", "detected", "disabled", "none"]),
  command: z.string().nullable(),
  reason: z.string().optional(),
  lockfiles: z.array(z.string()),
  inputs: z.array(z.strictObject({ path: z.string(), digest: digestSchema.nullable() })),
});
export type SetupSelection = z.infer<typeof setupSelectionSchema>;
const setupIntentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  ref: assignmentRefSchema,
  ownerEpoch: identitySchema,
  runtime: z.strictObject({ node: z.string(), platform: z.string(), architecture: z.string() }),
  key: digestSchema,
  selection: setupSelectionSchema,
  config: artifactRefSchema.optional(),
  cwd: z.string().min(1),
  sourceRoot: z.string().min(1),
  helper: z.string().min(1),
  requestId: z.uuid(),
  program: z.strictObject({ executable: z.string().min(1), args: z.array(z.string()) }),
  passEnv: configSchema.shape.passEnv.removeDefault(),
});
export type SetupIntent = z.infer<typeof setupIntentSchema>;
const setupOutcomeSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    intent: artifactRefSchema,
    state: z.enum(["completed", "failed", "not_started", "interrupted_unknown"]),
    code: z.number().int().nullable(),
    signal: z.string().nullable(),
    evidence: z.array(artifactRefSchema),
    cleanup: cleanupReceiptSchema,
    message: z.string().optional(),
  })
  .refine(
    (outcome) =>
      outcome.state !== "completed" ||
      (outcome.code === 0 && outcome.signal === null && outcome.cleanup.status === "stopped"),
    "Completed setup requires a zero exit without a signal",
  );

export type SetupOutcome = z.infer<typeof setupOutcomeSchema>;
const setupMarkerSchema = z.strictObject({
  schemaVersion: z.literal(1),
  key: digestSchema,
  outcome: artifactRefSchema,
});

async function regular(path: string): Promise<Buffer> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new DomainError("conflict", `Setup input/evidence is not a regular file: ${path}`);
  const file = await open(
    path,
    constants.O_RDONLY |
      (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK),
  );
  try {
    const before = await file.stat();
    if (before.ino !== stat.ino || before.dev !== stat.dev || !before.isFile())
      throw new DomainError("conflict", "Setup file identity changed");
    const bytes = await file.readFile();
    const after = await file.stat();
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      after.size !== bytes.length
    )
      throw new DomainError("conflict", "Setup file changed during capture");
    return bytes;
  } finally {
    await file.close();
  }
}
async function optional(path: string): Promise<Buffer | undefined> {
  try {
    return await regular(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}
async function available(name: string): Promise<boolean> {
  const extensions =
    process.platform === "win32"
      ? [
          "",
          ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT")
            .split(";")
            .map((extension) => extension.toLowerCase()),
        ]
      : [""];
  for (const directory of (process.env.PATH ?? process.env.Path ?? "").split(delimiter))
    for (const extension of extensions) {
      try {
        await access(join(directory, name + extension), constants.X_OK);
        return true;
      } catch {
        /* Search the next configured executable path. */
      }
    }
  return false;
}
export async function resolveSetup(
  setup: false | string | undefined,
  root: string,
): Promise<SetupSelection> {
  if (setup === false) return { source: "disabled", command: null, inputs: [], lockfiles: [] };
  const inputs: SetupSelection["inputs"] = [];
  for (const path of inputNames) {
    const bytes = await optional(join(root, path));
    inputs.push({ path, digest: bytes ? digestBytes(bytes) : null });
  }
  if (typeof setup === "string") {
    if (!setup.trim()) throw new DomainError("invalid_input", "Setup command is empty");
    return {
      source: "config",
      command: setup,
      inputs,
      lockfiles: inputs
        .filter((input) => input.digest && ecosystems.flat().some(([name]) => name === input.path))
        .map((input) => input.path),
    };
  }
  const files = new Set(inputs.filter((input) => input.digest !== null).map((input) => input.path));
  const commands: string[] = [];
  const lockfiles: string[] = [];
  for (const ecosystem of ecosystems) {
    const selected = ecosystem.filter(([name]) => files.has(name));
    const managers = new Set(selected.map(([, manager]) => manager));
    if (managers.size > 1)
      return {
        source: "none",
        command: null,
        inputs,
        lockfiles,
        reason: `Conflicting lockfiles (${selected.map(([name]) => name).join(", ")}); configure setup explicitly`,
      };
    if (!selected.length) continue;
    const [name, manager, command] = selected[0];
    if (!(await available(manager)))
      return {
        source: "none",
        command: null,
        inputs,
        lockfiles,
        reason: `${name} requires ${manager} on PATH or an explicit setup command`,
      };
    commands.push(
      manager === "yarn" && files.has(".yarnrc.yml") ? "yarn install --immutable" : command,
    );
    lockfiles.push(...selected.map(([file]) => file));
  }
  return commands.length
    ? { source: "detected", command: commands.join(" && "), inputs, lockfiles }
    : { source: "none", command: null, inputs, lockfiles, reason: "No root lockfile detected" };
}
export function setupKey(
  selection: SetupSelection,
  passEnv: readonly string[],
  runtime = {
    node: process.version,
    platform: String(process.platform),
    architecture: String(process.arch),
  },
): string {
  return digestValue({
    command: selection.command,
    inputs: selection.inputs,
    passEnv: [...passEnv].sort(),
    ...runtime,
  });
}

export class SetupJournal {
  readonly directory: string;
  private readonly artifacts: ArtifactPort;
  constructor(directory: string, artifacts: ArtifactPort) {
    this.directory = directory;
    this.artifacts = artifacts;
  }
  private intentPath(assignment: number): string {
    return join(this.directory, "intents", `${String(assignment).padStart(12, "0")}.json`);
  }
  private outcomePath(assignment: number): string {
    return join(this.directory, "outcomes", `${String(assignment).padStart(12, "0")}.json`);
  }
  private async readArtifact(reference: ArtifactRef): Promise<Buffer> {
    const bytes = await this.artifacts.read(reference);
    if (bytes.length !== reference.size || digestBytes(bytes) !== reference.digest)
      throw new DomainError("conflict", "Setup artifact integrity failure");
    return Buffer.from(bytes);
  }
  private async validateOutcome(intent: SetupIntent, outcome: SetupOutcome): Promise<void> {
    if (
      outcome.intent.digest !== digestValue(intent) ||
      outcome.cleanup.ownerEpoch !== intent.ownerEpoch
    )
      throw new DomainError("conflict", "Setup outcome or cleanup belongs to another intent owner");
    for (const reference of [...outcome.evidence, ...outcome.cleanup.evidence])
      await this.readArtifact(reference);
  }

  async assertSettled(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(join(this.directory, "intents"));
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    for (const name of names.filter((entry) => !entry.startsWith(".unaccepted-"))) {
      if (!/^\d{12}\.json$/.test(name))
        throw new DomainError("context_unavailable", "Setup journal contains unknown evidence");
      const intent = setupIntentSchema.parse(
        JSON.parse((await regular(join(this.directory, "intents", name))).toString()),
      );
      if (name !== `${String(intent.ref.assignment).padStart(12, "0")}.json`)
        throw new DomainError("conflict", "Setup intent filename differs from its assignment");
      const outcome = await this.readOutcome(intent.ref.assignment);
      if (outcome) await this.validateOutcome(intent, outcome.value);
      if (
        !outcome ||
        outcome.value.state === "interrupted_unknown" ||
        outcome.value.cleanup.status !== "stopped"
      )
        throw new DomainError(
          "context_unavailable",
          `Setup for assignment ${intent.ref.assignment} has uncertain effects; inspect retained evidence before choosing a replacement with explicit setup policy`,
        );
    }
  }
  async successful(key: string): Promise<ArtifactRef | undefined> {
    const bytes = await optional(join(this.directory, "success", `${key}.json`));
    if (!bytes) {
      let names: string[];
      try {
        names = await readdir(join(this.directory, "intents"));
      } catch (error) {
        if (isMissing(error)) return undefined;
        throw error;
      }
      for (const name of names.filter((entry) => /^\d{12}\.json$/.test(entry)).sort()) {
        const intent = setupIntentSchema.parse(
          JSON.parse((await regular(join(this.directory, "intents", name))).toString()),
        );
        if (intent.key !== key) continue;
        const outcome = await this.readOutcome(intent.ref.assignment);
        if (outcome?.value.state !== "completed") continue;
        await this.validateOutcome(intent, outcome.value);
        await this.markSuccessful(intent, outcome);
        return outcome.artifact;
      }
      return undefined;
    }
    const marker = setupMarkerSchema.parse(JSON.parse(bytes.toString()));
    if (marker.key !== key) throw new DomainError("conflict", "Setup marker key differs");
    const outcome = setupOutcomeSchema.parse(
      JSON.parse((await this.readArtifact(marker.outcome)).toString()),
    );
    const intent = setupIntentSchema.parse(
      JSON.parse((await this.readArtifact(outcome.intent)).toString()),
    );
    if (intent.key !== key || outcome.state !== "completed")
      throw new DomainError("conflict", "Setup marker lacks a successful command outcome");
    await this.validateOutcome(intent, outcome);
    return marker.outcome;
  }
  async create(options: {
    ref: AssignmentRef;
    ownerEpoch: string;
    selection: SetupSelection;
    config?: ArtifactRef;
    cwd: string;
    sourceRoot: string;
    helper: string;
    passEnv: readonly string[];
  }): Promise<{ value: SetupIntent; artifact: ArtifactRef }> {
    if (!options.selection.command) throw new Error("No setup command to prepare");
    setupEnvironment(options.passEnv, options.sourceRoot);
    const value = setupIntentSchema.parse({
      schemaVersion: 1,
      ...options,
      passEnv: [...options.passEnv],
      key: setupKey(options.selection, options.passEnv),
      runtime: { node: process.version, platform: process.platform, architecture: process.arch },
      requestId: randomUUID(),
      program: setupShell(options.selection.command),
    });
    return { value, artifact: await this.artifacts.put(Buffer.from(canonicalJson(value))) };
  }
  async publish(intent: SetupIntent): Promise<void> {
    await publishImmutable(
      this.intentPath(intent.ref.assignment),
      Buffer.from(canonicalJson(intent)),
      "workspace.setup.intent",
    );
  }
  async complete(
    intent: SetupIntent,
    artifact: ArtifactRef,
    reply: GitReply,
    cleanup: CleanupReceipt,
  ): Promise<{ value: SetupOutcome; artifact: ArtifactRef }> {
    return this.saveOutcome(intent, {
      schemaVersion: 1,
      intent: artifact,
      cleanup,
      state: reply.code === 0 && !reply.signal ? "completed" : "failed",
      code: reply.code,
      signal: reply.signal ?? null,
      evidence: reply.evidence ?? [],
      ...(reply.code !== 0 || reply.signal
        ? {
            message: `Setup exited ${reply.code}/${reply.signal ?? "none"}; inspect retained output`,
          }
        : {}),
    });
  }
  private async saveOutcome(
    intent: SetupIntent,
    value: SetupOutcome,
  ): Promise<{ value: SetupOutcome; artifact: ArtifactRef }> {
    await this.validateOutcome(intent, setupOutcomeSchema.parse(value));
    const bytes = Buffer.from(canonicalJson(value));
    const artifact = await this.artifacts.put(bytes);
    await publishImmutable(
      this.outcomePath(intent.ref.assignment),
      bytes,
      "workspace.setup.outcome",
    );
    return { value, artifact };
  }
  private async readOutcome(
    assignment: number,
  ): Promise<{ value: SetupOutcome; artifact: ArtifactRef } | undefined> {
    const bytes = await optional(this.outcomePath(assignment));
    if (!bytes) return undefined;
    const value = setupOutcomeSchema.parse(JSON.parse(bytes.toString()));
    return { value, artifact: await this.artifacts.put(bytes) };
  }
  async markSuccessful(
    intent: SetupIntent,
    outcome: { value: SetupOutcome; artifact: ArtifactRef },
  ): Promise<void> {
    if (outcome.value.state !== "completed") return;
    await this.validateOutcome(intent, outcome.value);
    await publishImmutable(
      join(this.directory, "success", `${intent.key}.json`),
      Buffer.from(canonicalJson({ schemaVersion: 1, key: intent.key, outcome: outcome.artifact })),
      "workspace.setup.success",
    );
  }
  async recover(
    reference: ArtifactRef,
    expected: {
      ref: AssignmentRef;
      ownerEpoch: string;
      cwd: string;
      sourceRoot: string;
      helpers: readonly string[];
      cleanup: CleanupReceipt;
    },
  ): Promise<ArtifactRef[]> {
    if (
      expected.cleanup.status !== "stopped" ||
      expected.cleanup.ownerEpoch !== expected.ownerEpoch
    )
      throw new DomainError(
        "owner_unconfirmed",
        "Setup recovery requires confirmed operation cleanup",
      );
    const intent = setupIntentSchema.parse(
      JSON.parse((await this.readArtifact(reference)).toString()),
    );
    if (
      digestValue(intent.ref) !== digestValue(expected.ref) ||
      intent.ownerEpoch !== expected.ownerEpoch ||
      intent.cwd !== expected.cwd ||
      intent.sourceRoot !== expected.sourceRoot ||
      !expected.helpers.includes(intent.helper)
    )
      throw new DomainError(
        "owner_unconfirmed",
        "Setup intent differs from its retained workspace operation",
      );
    if (setupKey(intent.selection, intent.passEnv, intent.runtime) !== intent.key)
      throw new DomainError("conflict", "Setup key differs from its immutable inputs");
    await this.publish(intent);
    let outcome = await this.readOutcome(intent.ref.assignment);
    if (!outcome) {
      const requestBytes = await optional(
        join(intent.helper, "requests", `${intent.requestId}.json`),
      );
      const evidence: ArtifactRef[] = [reference];
      if (!requestBytes)
        outcome = await this.saveOutcome(intent, {
          schemaVersion: 1,
          intent: reference,
          cleanup: expected.cleanup,
          state: "not_started",
          code: null,
          signal: null,
          evidence,
          message: "No setup command request was published; no dispatch was authorized",
        });
      else {
        const request = gitRequestSchema.parse(JSON.parse(requestBytes.toString()));
        const expectedRequest = {
          id: intent.requestId,
          cwd: intent.cwd,
          args: intent.program.args,
          env: {},
          program: {
            executable: intent.program.executable,
            passEnv: intent.passEnv,
            sourceRoot: intent.sourceRoot,
          },
        };
        if (canonicalJson(request) !== canonicalJson(expectedRequest))
          throw new DomainError(
            "owner_unconfirmed",
            "Setup helper request differs from its durable intent",
          );
        evidence.push(await this.artifacts.put(requestBytes));
        const resultDirectory = join(intent.helper, "results", intent.requestId);
        const resultBytes = await optional(join(resultDirectory, "result.json"));
        const stdout = await optional(join(resultDirectory, "stdout.bin"));
        const stderr = await optional(join(resultDirectory, "stderr.bin"));
        for (const bytes of [stdout, stderr])
          if (bytes) evidence.push(await this.artifacts.put(bytes));
        if (!resultBytes)
          outcome = await this.saveOutcome(intent, {
            schemaVersion: 1,
            intent: reference,
            cleanup: expected.cleanup,
            state: "interrupted_unknown",
            code: null,
            signal: null,
            evidence,
            message:
              "Setup dispatch lacks a completed command receipt; effects are uncertain and will not be replayed",
          });
        else {
          const result = gitCommandResultSchema.parse(JSON.parse(resultBytes.toString()));
          if (
            result.id !== intent.requestId ||
            result.requestDigest !== digestValue(request) ||
            !stdout ||
            !stderr ||
            result.stdout !== digestBytes(stdout) ||
            result.stderr !== digestBytes(stderr)
          )
            throw new DomainError(
              "owner_unconfirmed",
              "Setup command receipt or output integrity differs",
            );
          evidence.push(await this.artifacts.put(resultBytes));
          outcome = await this.saveOutcome(intent, {
            schemaVersion: 1,
            intent: reference,
            cleanup: expected.cleanup,
            state: result.code === 0 && !result.signal && !result.error ? "completed" : "failed",
            code: result.code,
            signal: result.signal ?? null,
            evidence,
            ...(result.error ? { message: result.error } : {}),
          });
        }
      }
    }
    if (outcome.value.intent.digest !== reference.digest)
      throw new DomainError("conflict", "Setup outcome belongs to another intent");
    await this.validateOutcome(intent, outcome.value);
    await this.markSuccessful(intent, outcome);
    return [reference, outcome.artifact, ...outcome.value.evidence];
  }
}
