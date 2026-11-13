import test from "node:test";
import { applicationBoundaryRecovery } from "./rewrite-application-boundary.ts";

test("every rollback destination and metadata write boundary retains correct cursor recovery", (t) =>
  applicationBoundaryRecovery(t, "rollback"));
