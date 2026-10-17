import { z } from "zod";

const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const scheduleSchema = z.object({
  mode: z.enum(["daily", "twice", "off", "frequent"]).default("daily"),
  time: time.default("09:00"),
  secondTime: time.default("14:00"),
  timeZone: z
    .string()
    .max(100)
    .refine((value) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: value });
        return true;
      } catch {
        return false;
      }
    })
    .default("Europe/Madrid"),
});
export type Schedule = z.infer<typeof scheduleSchema>;

/** UTC instants are matched to local clock times, including DST transitions. */
export function nextCheck(
  schedule: Schedule,
  intervalMinutes: number,
  after: number,
): string | null {
  if (schedule.mode === "off") return null;
  if (schedule.mode === "frequent")
    return new Date(after + intervalMinutes * 60000).toISOString();
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: schedule.timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const times = new Set([
    schedule.time,
    ...(schedule.mode === "twice" ? [schedule.secondTime] : []),
  ]);
  // Three days also cover a local clock time skipped by a DST transition.
  const first = Math.floor(after / 60000) * 60000 + 60000;
  for (let instant = first; instant <= first + 3 * 86400000; instant += 60000)
    if (times.has(formatter.format(instant)))
      return new Date(instant).toISOString();
  throw Error("invalidSettings");
}

export function startupDue(lastCheck: string | null, now: number): boolean {
  const last = Date.parse(lastCheck ?? "");
  return !Number.isFinite(last) || now - last > 86400000;
}
