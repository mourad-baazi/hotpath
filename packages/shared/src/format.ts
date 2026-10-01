/** 45ms / 1.1s: short durations stay readable. */
export function formatMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}
