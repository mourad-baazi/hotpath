// Dynamic input values, resolved when a scheduled run starts, in the schedule's
// time zone: "@today" on a 07:00 Europe/Paris run is the Paris date, not UTC's.

export const DYNAMIC_INPUTS = [
  "@today",
  "@yesterday",
  "@tomorrow",
  "@now",
  "@weekday",
] as const;

const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

export function isDynamic(value: string): boolean {
  return value.startsWith("@");
}

/** Throws with the accepted list when an @-value is unknown; literals pass. */
export function checkInputValue(name: string, value: string): void {
  if (
    isDynamic(value) &&
    !(DYNAMIC_INPUTS as readonly string[]).includes(value)
  ) {
    throw new Error(
      `input ${name}=${value}: unknown dynamic value — use one of ${DYNAMIC_INPUTS.join(", ")}, or a literal value`,
    );
  }
}

/** Calendar date (y, m, d) of `instant` in `timeZone`. */
function zonedDate(
  instant: Date,
  timeZone: string,
): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)!.value);
  return { y: get("year"), m: get("month"), d: get("day") };
}

// Day arithmetic on the calendar date itself (via UTC), so DST days with 23
// or 25 hours can't shift the result.
function shiftDate(
  date: { y: number; m: number; d: number },
  days: number,
): string {
  const utc = new Date(Date.UTC(date.y, date.m - 1, date.d + days));
  return utc.toISOString().slice(0, 10);
}

export function resolveInputValue(
  value: string,
  now: Date,
  timeZone: string,
): string {
  if (!isDynamic(value)) return value;
  const today = zonedDate(now, timeZone);
  switch (value) {
    case "@today":
      return shiftDate(today, 0);
    case "@yesterday":
      return shiftDate(today, -1);
    case "@tomorrow":
      return shiftDate(today, 1);
    case "@now":
      return now.toISOString();
    case "@weekday":
      return WEEKDAYS[
        new Date(shiftDate(today, 0) + "T00:00:00Z").getUTCDay()
      ]!;
    default:
      checkInputValue("value", value);
      return value;
  }
}

export function resolveInputs(
  inputs: Record<string, string>,
  now: Date,
  timeZone: string,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(inputs).map(([k, v]) => [
      k,
      resolveInputValue(v, now, timeZone),
    ]),
  );
}
