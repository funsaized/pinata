import { writes, reviews, type AgentDefinition } from "./definitions.ts";
// Per-role result schemas for the `submit_result` tool, ported from 0.7.0's envelope() and
// validateResult(). The schema is the tool's parameter schema; semantic rules that a schema
// cannot express are checked here and returned to the model as a tool error.
import { Type, type TSchema } from "typebox";
import type { AgentResult, Role } from "./types.ts";
import { relative } from "./validate.ts";

const text = (description?: string, maxLength = 64_000) =>
  Type.String({ minLength: 1, maxLength, ...(description && { description }) });

const finding = Type.Object(
  {
    severity: Type.Union(
      (["critical", "high", "medium", "low", "info"] as const).map((v) => Type.Literal(v)),
    ),
    message: text(),
    evidence: text("file:line and a concrete scenario"),
  },
  { additionalProperties: false },
);

const reportedCheck = Type.Object(
  {
    name: text("check or inspection"),
    status: Type.Union((["passed", "failed", "not-run"] as const).map((v) => Type.Literal(v))),
    detail: text("actual evidence, never invented"),
  },
  { additionalProperties: false },
);

const source = Type.Object(
  {
    url: Type.Optional(text("http(s) URL of the source")),
    path: Type.Optional(text("repository-relative source path")),
    title: text(),
    supports: text("the claim this source supports"),
    applicability: text("why it applies to this version and context"),
  },
  { additionalProperties: false },
);

// Fields every role reports.
function common(role: Role) {
  return {
    status: Type.Union(
      (["succeeded", "failed", "blocked", "cancelled"] as const).map((v) => Type.Literal(v)),
      {
        description:
          role === "reviewer"
            ? "succeeded when you completed the review, whatever the verdict (put the verdict in review.verdict); failed or blocked only when you could not complete it"
            : "succeeded only when the acceptance criteria are met with evidence",
      },
    ),
    summary: text("concise outcome"),
    changedFiles: Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), {
      description:
        role === "builder"
          ? "every path you changed, relative to the repository root, including new and deleted files"
          : "always empty: this role does not change files",
    }),
    checks: Type.Array(reportedCheck, { description: "checks or inspections you actually ran" }),
    findings: Type.Array(finding),
    blockers: Type.Array(text(), { description: "empty unless status is blocked or failed" }),
  };
}

export function resultSchema(agent: Role | AgentDefinition): TSchema {
  const definition = typeof agent === "string" ? undefined : agent;
  const role = typeof agent === "string" ? agent : agent.name;
  const kind = definition
    ? writes({ definition })
      ? "builder"
      : reviews({ definition })
        ? "reviewer"
        : "reader"
    : role;
  const fields: Record<string, TSchema> = common(kind);
  if (definition) {
    fields.brief = text("concise findings with supporting evidence");
    fields.sources = Type.Array(source);
    fields.data = Type.Record(Type.String(), Type.Unknown());
  }
  if (!definition && (role === "scout" || role === "planner"))
    fields.brief = text("one plain-text string: findings with file:line evidence");
  if (!definition && role === "research") {
    fields.brief = text("one plain-text string, at most 8000 characters", 8000);
    fields.sources = Type.Array(source, { description: "at least one source when succeeded" });
  }
  if (kind === "reviewer")
    fields.review = Type.Object(
      {
        verdict: Type.Union([Type.Literal("approve"), Type.Literal("changes_requested")], {
          description: "approve only with no unresolved critical, high or medium findings",
        }),
        taskId: Type.Optional(
          Type.Union([Type.String(), Type.Null()], { description: "the reviewed task ID" }),
        ),
        fingerprint: Type.Optional(
          Type.String({ description: "the review target fingerprint from the brief" }),
        ),
      },
      { additionalProperties: false },
    );
  const optional = new Set([
    "brief",
    "sources",
    "review",
    "data",
    ...(definition
      ? [...(kind === "builder" ? [] : ["changedFiles"]), "checks", "findings", "blockers"]
      : []),
  ]);
  return Type.Object(
    Object.fromEntries(
      Object.entries(fields).map(([k, v]) => [k, optional.has(k) ? Type.Optional(v) : v]),
    ),
    { additionalProperties: false },
  );
}

export interface ResultContext {
  role: Role;
  definition?: AgentDefinition;
  // A reviewer's target: the builder task (or null for existing changes) and its fingerprint.
  reviewTarget?: { taskId: string | null; fingerprint: string };
}

export class ResultError extends Error {
  override name = "ResultError";
}

function fail(message: string): never {
  throw new ResultError(message);
}

// Binds a review to the target the reviewer was launched against.
function bind(
  review: NonNullable<AgentResult["review"]>,
  target: NonNullable<ResultContext["reviewTarget"]>,
) {
  if (review.fingerprint !== undefined && review.fingerprint !== target.fingerprint)
    fail(`review.fingerprint must be ${target.fingerprint}, the target you reviewed.`);
  if (review.taskId !== undefined && review.taskId !== target.taskId)
    fail(`review.taskId must be ${JSON.stringify(target.taskId)}.`);
  return { ...review, taskId: target.taskId, fingerprint: target.fingerprint };
}

// Checks the rules a schema cannot express. Returns the result with reviewer bindings filled in.
export function validateResult(input: AgentResult, ctx: ResultContext): AgentResult {
  const result: AgentResult = {
    ...input,
    changedFiles: input.changedFiles ?? [],
    checks: input.checks ?? [],
    findings: input.findings ?? [],
    blockers: input.blockers ?? [],
  };
  if (Buffer.byteLength(JSON.stringify(result)) > 128 * 1024)
    fail("Result exceeds 128 KiB; return a concise result and reference larger artifacts.");
  const writer = writes(ctx);
  const reviewer = reviews(ctx);
  if (result.status === "succeeded" && result.blockers.length)
    fail("A succeeded result cannot list blockers; use status blocked or failed, or remove them.");
  const seen = new Set<string>();
  for (const file of result.changedFiles) {
    try {
      relative(file);
    } catch {
      fail(
        `changedFiles entry ${JSON.stringify(file)} must be a repository-relative path with / separators.`,
      );
    }
    if (seen.has(file)) fail(`changedFiles lists ${JSON.stringify(file)} twice.`);
    seen.add(file);
  }
  if (!writer && result.changedFiles.length)
    fail(`A ${ctx.role} does not change files; changedFiles must be empty.`);
  if (reviewer && result.review && ctx.reviewTarget)
    result.review = bind(result.review, ctx.reviewTarget);
  if (result.status !== "succeeded") return result;
  if (
    (ctx.definition
      ? ctx.definition.output.require.includes("brief")
      : ["scout", "planner", "research"].includes(ctx.role)) &&
    !result.brief
  )
    fail(`A succeeded ${ctx.role} result needs brief: the findings, with file:line evidence.`);
  if (
    ctx.definition
      ? ctx.definition.output.require.includes("sources") || result.sources !== undefined
      : ctx.role === "research"
  ) {
    if (!result.sources?.length) fail("A succeeded research result needs at least one source.");
    for (const s of result.sources) {
      if (ctx.definition && s.path !== undefined) {
        if (s.url !== undefined) fail("A source must name either a URL or a local path");
        try {
          relative(s.path);
        } catch {
          fail(`Invalid source path ${s.path}`);
        }
        continue;
      }
      let url: URL;
      try {
        url = new URL(s.url ?? "");
      } catch {
        fail(`Source URL ${JSON.stringify(s.url)} is not a valid URL.`);
      }
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
        fail(`Source URL ${JSON.stringify(s.url)} must be http(s) without credentials.`);
    }
  }
  if (reviewer) {
    const review = result.review;
    if (!review) fail("A succeeded reviewer result needs review: { verdict }.");

    if (
      review.verdict === "approve" &&
      result.findings.some(
        (f) => f.severity === "critical" || f.severity === "high" || f.severity === "medium",
      )
    )
      fail(
        "An approval cannot contain unresolved critical, high or medium findings. Use changes_requested, or downgrade findings that are not defects.",
      );
  }
  return result;
}
