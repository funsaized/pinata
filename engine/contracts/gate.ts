import { z } from "zod";
import { assignmentRefSchema, identitySchema, textSchema } from "./common.ts";
import { ownerSchema } from "./owner.ts";

export const checkoutIdentitySchema = z.strictObject({
  root: textSchema,
  device: textSchema,
  inode: textSchema,
});
export type CheckoutIdentity = z.infer<typeof checkoutIdentitySchema>;
export const checkoutGateManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  checkout: checkoutIdentitySchema,
});
export const checkoutDirectoryBindingSchema = z.strictObject({
  schemaVersion: z.literal(1),
  checkout: checkoutIdentitySchema,
  birthtimeNs: z.string().regex(/^[1-9][0-9]*$/),
});
const leaseFields = {
  schemaVersion: z.literal(1),
  id: identitySchema,
  checkout: checkoutIdentitySchema,
  owner: ownerSchema,
  ownerEpoch: identitySchema,
};
export const writerLeaseSchema = z.strictObject({
  ...leaseFields,
  kind: z.literal("writer"),
  ref: assignmentRefSchema,
});
export type WriterLease = z.infer<typeof writerLeaseSchema>;
export const exclusiveLeaseSchema = z.strictObject({
  ...leaseFields,
  kind: z.literal("exclusive"),
  operationId: identitySchema,
  purpose: z.enum(["apply", "rollback", "recovery"]),
});
export type ExclusiveLease = z.infer<typeof exclusiveLeaseSchema>;
