/**
 * Relative age in the compact form the activity surfaces use: "gerade eben", "vor 7 Min.",
 * "vor 3 Std.", "vor 2 T.". Deliberately coarse — these timestamps say how stale something is,
 * not when it happened.
 */
export function formatRelativeTime(date: Date): string {
  const minutes = Math.floor(Math.max(0, Date.now() - new Date(date).getTime()) / 60_000)
  if (minutes < 1) return 'gerade eben'
  if (minutes < 60) return `vor ${minutes} Min.`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `vor ${hours} Std.`
  return `vor ${Math.floor(hours / 24)} T.`
}
