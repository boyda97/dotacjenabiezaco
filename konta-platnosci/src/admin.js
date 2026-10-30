// Panel właściciela (/admin), tylko dla kont z ADMIN_EMAILS: statystyki, klienci, nabory w bazie,
// wysłane e-maile. Akcje: darmowy dostęp dla klienta (np. reklamacja, znajomy) i ręczne wysłanie alertów.
import express from "express";
import { getAccess, passStart, nowSec } from "./entitlements.js";
import { runAlerts, alertsEnabled, warsawNow } from "./alerts.js";

export function createAdmin({ db, cfg, auth, catalog, mailer, loadPrograms, log = console }) {
  const router = express.Router();
  router.use(auth.requireUser, (req, res, next) => {
    if (!cfg.adminEmails.includes(req.user.email.toLowerCase())) return res.status(403).json({ error: "forbidden" });
    res.set("Cache-Control", "no-store");
    next();
  });

  // Statystyki: dzienne liczniki z src/stats.js + liczby z bazy kont.
  router.get("/stats", (req, res) => {
    const days = Math.min(Number(req.query.dni) || 30, 365);
    const from = new Date(Date.now() - (days - 1) * 864e5).toISOString().slice(0, 10);
    const daily = {};
    for (const r of db.prepare("SELECT day, name, n FROM stat_daily WHERE day >= ? ORDER BY day").all(from))
      (daily[r.day] ||= { day: r.day })[r.name] = r.n;
    const top = (col) => db.prepare(
      `SELECT ${col} AS k, SUM(n) AS n FROM stat_views WHERE day >= ? AND ${col} != '' GROUP BY ${col} ORDER BY n DESC LIMIT 15`
    ).all(from);
    const now = nowSec();
    const one = (sql, ...a) => db.prepare(sql).get(...a).n;
    res.json({
      days, daily: Object.values(daily), pages: top("path"), refs: top("ref"),
      totals: {
        users: one("SELECT COUNT(*) n FROM users WHERE email NOT LIKE '%@usuniete.invalid'"),
        newUsers: one("SELECT COUNT(*) n FROM users WHERE created_at >= ?", now - days * 86400),
        subscriptions: one(`SELECT COUNT(DISTINCT user_id) n FROM subscriptions WHERE status IN ('active','trialing','past_due') AND current_period_end > ?`, now),
        weeks: one("SELECT COUNT(*) n FROM passes WHERE revoked_at IS NULL AND starts_at >= ? AND id NOT LIKE 'admin_%'", now - days * 86400),
        weeksActive: one("SELECT COUNT(DISTINCT user_id) n FROM passes WHERE revoked_at IS NULL AND starts_at <= ? AND ends_at > ?", now, now),
        favorites: one("SELECT COUNT(*) n FROM favorites"),
      },
    });
  });

  // Klienci: e-mail, od kiedy, dostęp, ulubione, wyszukiwanie, alerty.
  router.get("/users", (req, res) => {
    const q = `%${String(req.query.q || "").trim().toLowerCase()}%`;
    const rows = db.prepare(
      `SELECT u.id, u.email, u.created_at,
         (SELECT COUNT(*) FROM favorites f WHERE f.user_id = u.id) AS favorites,
         (SELECT label FROM search_profiles s WHERE s.user_id = u.id) AS search,
         (SELECT MAX(sent_at) FROM alert_log a WHERE a.user_id = u.id) AS last_alert
       FROM users u WHERE u.email LIKE ? AND u.email NOT LIKE '%@usuniete.invalid'
       ORDER BY u.created_at DESC LIMIT 300`
    ).all(q);
    res.json({
      users: rows.map((r) => ({
        ...r, search: r.search ? String(r.search).split("\n")[0] : null,
        access: getAccess(db, cfg, r.id), alerts: alertsEnabled(db, r.id),
      })),
    });
  });

  // Darmowy dostęp na N dni (dokleja się do trwającego, jak kupiony tydzień). Nie dotyczy płatności w Stripe.
  router.post("/users/:id/gift", (req, res) => {
    const id = Number(req.params.id), days = Math.round(Number(req.body?.days));
    if (!db.prepare("SELECT 1 FROM users WHERE id = ?").get(id)) return res.status(404).json({ error: "not_found" });
    if (!(days >= 1 && days <= 366)) return res.status(400).json({ error: "bad_days" });
    const start = passStart(db, id);
    db.prepare("INSERT INTO passes (id, user_id, plan, starts_at, ends_at, amount) VALUES (?,?,?,?,?,0)")
      .run(`admin_${id}_${Date.now()}`, id, cfg.weekPassPlan, start, start + days * 86400);
    log.info?.(`Admin ${req.user.email}: ${days} dni dostępu dla użytkownika ${id}`);
    res.json({ access: getAccess(db, cfg, id) });
  });

  // Nabory w bazie silnika: liczby według źródła i stanu oraz lista (bez opisów).
  router.get("/programs", async (_req, res) => {
    let all = [];
    try {
      all = await catalog();
    } catch (e) {
      return res.status(503).json({ error: "catalog_unavailable", detail: e.message });
    }
    const count = (key) => all.reduce((m, p) => ((m[p[key] || "?"] = (m[p[key] || "?"] || 0) + 1), m), {});
    res.json({
      total: all.length, bySource: count("source"), byStatus: count("status"),
      withDocuments: all.filter((p) => p.documents?.length).length,
      programs: all
        .map(({ id, name, op, source, status, deadline, max, type, checked, url, regions }) =>
          ({ id, name, op, source, status, deadline, max, type, checked, url, regional: !!regions }))
        .sort((a, b) => (a.deadline || "9999").localeCompare(b.deadline || "9999")),
    });
  });

  // Wysłane e-maile z nowymi naborami i najbliższy termin wysyłki.
  router.get("/alerts", (_req, res) => {
    const { weekday } = warsawNow();
    const daysToNext = ((cfg.alertsWeekday - weekday + 7) % 7) || 7;
    const next = new Date(Date.now() + daysToNext * 864e5).toISOString().slice(0, 10);
    res.json({
      schedule: cfg.alertsHour ? { weekday: cfg.alertsWeekday, hour: cfg.alertsHour, next } : null,
      lastRun: db.prepare("SELECT value FROM meta WHERE key = 'alerts_last_day'").get()?.value ?? null,
      log: db.prepare(
        `SELECT a.sent_at, a.fresh, a.reminders, COALESCE(u.email, '(usunięte)') AS email
         FROM alert_log a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 100`
      ).all(),
    });
  });

  // Ręczna wysyłka (np. test po zmianach). Wysyła tylko to, czego jeszcze nie wysłano.
  router.post("/alerts/run", async (_req, res) => {
    const sent = await runAlerts({ db, cfg, mailer, loadPrograms, log });
    res.json({ sent });
  });

  return router;
}
