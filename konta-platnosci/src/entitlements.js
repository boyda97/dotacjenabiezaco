// Jedno źródło prawdy o tym, czy użytkownik ma opłacony dostęp.
const DAY = 86400;

export function getAccess(db, cfg, userId, now = nowSec()) {
  if (!userId) return { active: false };

  const sub = db
    .prepare(
      `SELECT plan, status, current_period_end, cancel_at_period_end FROM subscriptions
       WHERE user_id = ? AND status IN ('active','trialing','past_due')
       ORDER BY current_period_end DESC LIMIT 1`
    )
    .get(userId);
  if (sub) {
    const until =
      sub.status === "past_due"
        ? sub.current_period_end + cfg.pastDueGraceDays * DAY
        : sub.current_period_end;
    if (until > now) {
      return {
        active: true,
        kind: "subscription",
        plan: sub.plan,
        status: sub.status,
        until,
        cancelAtPeriodEnd: !!sub.cancel_at_period_end,
      };
    }
  }

  const pass = db
    .prepare(
      `SELECT plan FROM passes
       WHERE user_id = ? AND revoked_at IS NULL AND starts_at <= ? AND ends_at > ? LIMIT 1`
    )
    .get(userId, now, now);
  if (pass) {
    // Dokupione tygodnie są doklejane na koniec, więc dostęp trwa do końca ostatniego.
    const { until } = db
      .prepare(`SELECT MAX(ends_at) AS until FROM passes WHERE user_id = ? AND revoked_at IS NULL`)
      .get(userId);
    return { active: true, kind: "week", plan: pass.plan, until };
  }

  return { active: false };
}

export function hasActiveSubscription(db, userId, now = nowSec()) {
  return !!db
    .prepare(
      `SELECT 1 FROM subscriptions WHERE user_id = ? AND status IN ('active','trialing','past_due')
       AND current_period_end > ?`
    )
    .get(userId, now);
}

// Kolejny tydzień kupiony w trakcie trwającego dostępu przedłuża go, a nie nadpisuje.
export function passStart(db, userId, now = nowSec()) {
  const row = db
    .prepare(`SELECT MAX(ends_at) AS e FROM passes WHERE user_id = ? AND revoked_at IS NULL`)
    .get(userId);
  return row?.e && row.e > now ? row.e : now;
}

export const nowSec = () => Math.floor(Date.now() / 1000);
