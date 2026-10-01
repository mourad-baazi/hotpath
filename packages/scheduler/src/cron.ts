import { Cron } from "croner";

export function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function checkTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    throw new Error(
      `unknown time zone "${timeZone}" — use an IANA name such as Europe/Paris or America/New_York`,
    );
  }
}

function job(cron: string, timeZone: string): Cron {
  // paused: we only use croner to compute times; the daemon owns the timers
  return new Cron(cron, { timezone: timeZone, paused: true });
}

export function checkCron(cron: string, timeZone: string): void {
  checkTimeZone(timeZone);
  let next: Date | null;
  try {
    next = job(cron, timeZone).nextRun();
  } catch (err) {
    throw new Error(
      `invalid cron "${cron}": ${err instanceof Error ? err.message : String(err)} — ` +
        'example: "0 7 * * 1-5" (07:00 on weekdays)',
    );
  }
  if (!next) {
    throw new Error(`cron "${cron}" never runs — check the expression`);
  }
}

/** First run strictly after `after`. */
export function nextRun(
  cron: string,
  timeZone: string,
  after: Date,
): Date | null {
  return job(cron, timeZone).nextRun(after);
}

/** The latest scheduled slot in (after, now], if any. */
export function latestSlot(
  cron: string,
  timeZone: string,
  after: Date,
  now: Date,
): Date | null {
  const first = nextRun(cron, timeZone, after);
  if (!first || first > now) return null;
  const [prev] = job(cron, timeZone).previousRuns(
    1,
    new Date(now.getTime() + 1),
  );
  return prev && prev > after ? prev : first;
}
