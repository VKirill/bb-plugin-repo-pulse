export const failedCheck = (conclusion: string | null | undefined) =>
  ["failure", "timed_out", "action_required", "startup_failure"].includes(
    conclusion ?? "",
  );
export const gateStep = (name: string) => /\bgate:v1\b/i.test(name);
const labelMessage = (text: string) =>
  /Frozen\s+v1\s+entries\s+changed/i.test(text) &&
  /Add\s+the\s+["']?v1-change["']?\s+label/i.test(text);
type Annotation = {
  annotation_level?: string;
  message?: string;
  raw_details?: string;
};
type Step = { name: string; conclusion?: string | null };
export function maintainerGateOnly(
  check: {
    name?: string;
    output?: { summary?: string | null; text?: string | null };
  },
  annotations: Annotation[],
  steps?: Step[],
  log = "",
): boolean {
  const errors = annotations
    .filter((a) => a.annotation_level === "failure")
    .map((a) => `${a.message ?? ""}\n${a.raw_details ?? ""}`)
    .filter(
      (text) => !/^Process completed with exit code \d+\.\s*$/.test(text),
    );
  // A second concrete validation error must remain actionable, even alongside a gate message.
  if (errors.some((text) => !labelMessage(text))) return false;
  const evidence = [
    log,
    ...errors,
    check.output?.summary ?? "",
    check.output?.text ?? "",
  ].some(labelMessage);
  const otherLogError = log.split(/\r?\n/).some((line) => {
    const error = line.match(/(?:\berror:|::error::)\s*(.*)/i)?.[1];
    return (
      error &&
      !/Frozen\s+v1\s+entries\s+changed|Add\s+the\s+["']?v1-change["']?\s+label|^Process completed with exit code \d+\./i.test(
        error,
      )
    );
  });
  if (otherLogError) return false;
  if (steps) {
    const failed = steps.filter((s) => failedCheck(s.conclusion));
    return (
      failed.length > 0 &&
      failed.every((s) => s.conclusion === "failure" && gateStep(s.name)) &&
      evidence
    );
  }
  return evidence && (errors.length > 0 || gateStep(check.name ?? ""));
}
