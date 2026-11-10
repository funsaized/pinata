import test from "node:test";
import { applicationBoundaryRecovery } from "./rewrite-application-boundary.ts";

test(
  "every apply destination and metadata write boundary retains correct cursor recovery",
  { timeout: 300_000 },
  () => applicationBoundaryRecovery("apply"),
);
