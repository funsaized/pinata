// New inputs default to optional; absent saved policy preserves historical requirements.
export type ReviewPolicy = "optional" | "required";

export function reviewPolicy(value: unknown = "optional"): ReviewPolicy {
  if (value !== "optional" && value !== "required")
    throw new Error('reviewPolicy must be "optional" or "required"');
  return value;
}

export function savedReviewPolicy(record: { reviewPolicy?: ReviewPolicy }): ReviewPolicy {
  return reviewPolicy(record.reviewPolicy ?? "required");
}
