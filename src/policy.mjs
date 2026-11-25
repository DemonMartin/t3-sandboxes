export const defaults = Object.freeze({
  idleMinutes: 15,
  waitingMinutes: 60,
  unattendedMinutes: 120,
  continuousMinutes: 720,
  deleteDays: 7,
  deleteOnThreadDelete: true,
  maxRunning: 3,
  monthlyBudget: 0,
  // Every new chat starts in its own sandbox unless the draft opts out.
  autoSandbox: true,
});
const booleans = new Set(["deleteOnThreadDelete", "autoSandbox"]);
export function policy(input = {}) {
  const result = { ...defaults, ...input };
  for (const [key, value] of Object.entries(result)) {
    if (booleans.has(key)) {
      if (typeof value !== "boolean") throw new Error(`Invalid policy: ${key}`);
    } else if (
      !Object.hasOwn(defaults, key) ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > 525600
    )
      throw new Error(`Invalid policy: ${key}`);
  }
  for (const key of [
    "idleMinutes",
    "waitingMinutes",
    "unattendedMinutes",
    "continuousMinutes",
    "maxRunning",
  ])
    if (result[key] < 1) throw new Error(`Invalid policy: ${key}`);
  return result;
}
const SETTLED_GRACE_MS = 2 * 60000;
/** Idle windows offered per sandbox, in minutes. */
export const idleChoices = Object.freeze([10, 30, 60, 240, 720, 1440]);
/** The policy as it applies to one sandbox: its own idle window, and a lifetime that fits it. */
export function effective(p, row) {
  const idleMinutes = row.idleMinutes ?? p.idleMinutes;
  return {
    ...p,
    idleMinutes,
    continuousMinutes: Math.max(p.continuousMinutes, idleMinutes * 2),
  };
}
/** When a running sandbox will stop if nothing changes, and why; null while it is working. */
export function outlook(row, now, p) {
  const activity = row.activity;
  if (row.state !== "running" || !activity) return null;
  if (row.keepAwakeUntil > now) return { reason: "awake", at: row.keepAwakeUntil };
  if (activity.closed) return { reason: "settled", at: row.startedAt + SETTLED_GRACE_MS };
  if (activity.active) return null;
  if (activity.waiting)
    return { reason: "waiting", at: (row.waitingSince ?? now) + p.waitingMinutes * 60000 };
  return {
    reason: "idle",
    at: Math.max(row.lastActivity, activity.lastActivity ?? 0) + p.idleMinutes * 60000,
  };
}
export function decide(row, activity, now, p) {
  if (row.desired !== "running") return row.desired;
  if (now >= row.startedAt + p.continuousMinutes * 60000) return "stopped";
  if (row.keepAwakeUntil > now) return "running";
  if (!activity) return "unknown";
  // With every thread settled the sandbox has no work left and stops. One that was just
  // started gets a short grace first: the user may have resumed it to look at, or continue,
  // a settled thread, and it must not stop under them the moment it comes up.
  if (activity.closed)
    return !activity.threads?.length || now >= row.startedAt + SETTLED_GRACE_MS
      ? "stopped"
      : "running";
  if (activity.active) return "running";
  if (activity.waiting)
    return now >= (row.waitingSince ?? now) + p.waitingMinutes * 60000 ? "stopped" : "running";
  return now >= Math.max(row.lastActivity, activity.lastActivity ?? 0) + p.idleMinutes * 60000
    ? "stopped"
    : "running";
}
export function deadline(row, activity, now, p) {
  const hard = row.startedAt + p.continuousMinutes * 60000;
  const next =
    row.keepAwakeUntil > now
      ? row.keepAwakeUntil
      : activity?.active
        ? now + p.unattendedMinutes * 60000
        : activity?.waiting
          ? (row.waitingSince ?? now) + p.waitingMinutes * 60000
          : row.lastActivity + p.idleMinutes * 60000;
  return Math.min(hard, next);
}
export function tone(state) {
  return state === "running"
    ? "success"
    : state === "stopped"
      ? "muted"
      : ["starting", "stopping", "deleting"].includes(state)
        ? "warning"
        : "danger";
}
