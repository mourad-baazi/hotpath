import { z } from "zod";

// Scheduler state (ship/phases/P2-scheduler.md), all under .hotpath/.

export const scheduleSchema = z.object({
  id: z.string(),
  task: z.string(),
  cron: z.string(),
  /** IANA time zone the cron expression and @-inputs are evaluated in */
  timezone: z.string(),
  /** literal values, or @today/@yesterday/@tomorrow/@now/@weekday */
  inputs: z.record(z.string(), z.string()),
  enabled: z.boolean(),
  /** "dry-run" skips side-effect steps until the user allows them */
  sideEffects: z.enum(["dry-run", "allow"]),
  /** on drift: run the agent (auto), report only (notify), or just fail (off) */
  fallback: z.enum(["auto", "notify", "off"]),
  createdAt: z.string(),
});
export type Schedule = z.infer<typeof scheduleSchema>;

export const schedulesFileSchema = z.object({
  version: z.literal(1),
  schedules: z.array(scheduleSchema),
});
export type SchedulesFile = z.infer<typeof schedulesFileSchema>;

export const runStatusSchema = z.enum(["ok", "drift", "failed", "skipped"]);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const runRecordSchema = z.object({
  scheduleId: z.string().nullable(),
  task: z.string(),
  startedAt: z.string(),
  durationMs: z.number().nonnegative(),
  status: runStatusSchema,
  llmCalls: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  /** the agent fallback ran */
  fallback: z.boolean(),
  sideEffectsMode: z.enum(["dry-run", "allow"]),
  error: z.string().optional(),
});
export type RunRecord = z.infer<typeof runRecordSchema>;

export const hotpathConfigSchema = z.object({
  notify: z
    .object({
      desktop: z.boolean().optional(),
      webhook: z.string().url().optional(),
    })
    .optional(),
});
export type HotpathConfig = z.infer<typeof hotpathConfigSchema>;
