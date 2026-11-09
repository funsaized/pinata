import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { BackendLaunch } from "../contracts/backend.ts";
import { assignmentKey, DomainError } from "../contracts/common.ts";
import { canonicalJson } from "../contracts/digest.ts";
import { dependencyQuerySchema, type DependencyPage } from "../contracts/dependencies.ts";
import { resultSchema } from "../contracts/lifecycle.ts";
import { piParameters } from "../pi/schema.ts";
import { digestBytes } from "../storage/io.ts";

export const dependencyTool = "pinata_dependency";
const entriesPerPage = 8;
const summaryLength = 512;
const resultPageLength = 12_000;
const contentBytes = 32_768;

function endOfPage(text: string, offset: number, length: number): number {
  const end = Math.min(text.length, offset + length);
  // Keep UTF-16 surrogate pairs together so each model-facing page is readable.
  return end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) ? end - 1 : end;
}

export function dependencyList(
  dependencies: BackendLaunch["brief"]["dependencies"],
  offset = 0,
): Extract<DependencyPage, { kind: "list" }> {
  if (offset > dependencies.length)
    throw new DomainError("invalid_input", "Dependency page offset exceeds the list length");
  const entries: Extract<DependencyPage, { kind: "list" }>["entries"] = [];
  const page = (): Extract<DependencyPage, { kind: "list" }> => {
    const next = offset + entries.length;
    return {
      kind: "list",
      offset,
      total: dependencies.length,
      entries,
      ...(next < dependencies.length ? { next } : {}),
    };
  };
  for (const { ref, result, artifact } of dependencies.slice(offset, offset + entriesPerPage)) {
    const end = endOfPage(result.summary, 0, summaryLength);
    entries.push({
      ref,
      execution: result.execution,
      summary: result.summary.slice(0, end),
      summaryComplete: end === result.summary.length,
      artifact,
    });
    if (Buffer.byteLength(canonicalJson(page())) > contentBytes) {
      entries.pop();
      if (!entries.length)
        throw new DomainError(
          "invalid_input",
          "Dependency reference exceeds the page metadata limit",
        );
      break;
    }
  }
  return page();
}

export async function readDependency(
  launch: Pick<BackendLaunch, "brief" | "artifacts">,
  input: unknown,
): Promise<DependencyPage> {
  const query = dependencyQuerySchema.parse(input);
  if (query.kind === "list") return dependencyList(launch.brief.dependencies, query.offset);
  const dependency = launch.brief.dependencies.find(
    ({ ref }) => assignmentKey(ref) === assignmentKey(query.ref),
  );
  if (!dependency)
    throw new DomainError(
      "capability_denied",
      "Only this assignment's frozen dependency results are available",
    );
  const bytes = await launch.artifacts.read(dependency.artifact);
  if (
    bytes.byteLength !== dependency.artifact.size ||
    digestBytes(bytes) !== dependency.artifact.digest
  )
    throw new DomainError("context_unavailable", "Retained dependency artifact integrity failure");
  const text = Buffer.from(bytes).toString("utf8");
  const result = resultSchema.parse(JSON.parse(text));
  if (assignmentKey(result.ref) !== assignmentKey(query.ref))
    throw new DomainError(
      "context_unavailable",
      "Retained dependency artifact has a different assignment identity",
    );
  if (
    query.offset > text.length ||
    (query.offset > 0 && /[\uDC00-\uDFFF]/.test(text[query.offset] ?? ""))
  )
    throw new DomainError("invalid_input", "Use a returned dependency page offset");
  let length = resultPageLength;
  for (;;) {
    const end = endOfPage(text, query.offset, length);
    const page: DependencyPage = {
      kind: "result",
      ref: dependency.ref,
      artifact: dependency.artifact,
      offset: query.offset,
      total: text.length,
      text: text.slice(query.offset, end),
      ...(end < text.length ? { next: end } : {}),
    };
    if (Buffer.byteLength(canonicalJson(page)) <= contentBytes) return page;
    length = Math.floor(length / 2);
    if (length < 4)
      throw new DomainError(
        "invalid_input",
        "Dependency reference exceeds the page metadata limit",
      );
  }
}

// The closure exposes only references frozen into this launch. Model input cannot
// select another run's artifact or widen filesystem/tool authority.
export function dependencyExtension(launch: BackendLaunch): ExtensionFactory {
  return (pi) => {
    pi.registerTool({
      name: dependencyTool,
      label: "Read dependency results",
      description:
        "List frozen dependency summaries or read one exact assignment's complete retained result in pages. Follow next as offset with the same kind/ref. Execution and reported checks are separate observations.",
      parameters: piParameters(dependencyQuerySchema),
      async execute(_id, input) {
        const page = await readDependency(launch, input);
        return { content: [{ type: "text", text: canonicalJson(page) }], details: page };
      },
    });
  };
}
