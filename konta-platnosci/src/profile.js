// Profil użytkownika: ulubione programy (z etapem przygotowania i notatką), zapisany profil wyszukiwania
// i eksport terminów do kalendarza (.ics). Wszystko wymaga zalogowania, ale nie opłaconego dostępu:
// zapisać można tylko to, co użytkownik już widział (np. darmowy program z próbki).
import express from "express";
import { getAccess, nowSec } from "./entitlements.js";
import { alertsEnabled, setAlertsEnabled } from "./alerts.js";

export const STATUSES = ["nowy", "przygotowuje", "zlozony", "pominiety"];
const MAX_FAVORITES = 200;
const PROGRAM_FIELDS = ["name", "op", "level", "type", "status", "deadline", "max", "url"];

const str = (v, n) => (v == null || v === "" ? undefined : String(v).slice(0, n));

// Kopia karty programu: tylko znane pola, przycięte, url wyłącznie http(s).
export function cleanProgram(p) {
  if (!p || typeof p !== "object") return null;
  const out = {};
  for (const k of PROGRAM_FIELDS) {
    if (k === "max") {
      const n = Number(p.max);
      if (Number.isFinite(n) && n > 0) out.max = Math.round(n);
    } else if (k === "url") {
      if (typeof p.url === "string" && /^https?:\/\//i.test(p.url)) out.url = p.url.slice(0, 500);
    } else {
      const v = str(p[k], k === "name" ? 200 : 100);
      if (v !== undefined) out[k] = v;
    }
  }
  return out.name ? out : null;
}

const row2fav = (r) => ({
  id: r.program_id, program: JSON.parse(r.program), status: r.status, note: r.note || "",
  savedAt: r.created_at, updatedAt: r.updated_at,
});

const icsText = (s) => String(s).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/[,;]/g, (c) => "\\" + c);
// Linie .ics nie mogą przekraczać 75 bajtów; dłuższe zawijamy (kontynuacja zaczyna się spacją).
function fold(line) {
  const out = [];
  let cur = "", bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    if (bytes + b > 74) { out.push(cur); cur = " "; bytes = 1; }
    cur += ch; bytes += b;
  }
  out.push(cur);
  return out.join("\r\n");
}

export function favoritesIcs(favs, appUrl, stamp = new Date()) {
  const dt = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Dotacjo//Terminy naborów//PL", "CALSCALE:GREGORIAN",
    "X-WR-CALNAME:Dotacjo – terminy naborów"];
  for (const f of favs) {
    const d = /^\d{4}-\d{2}-\d{2}/.exec(f.program.deadline || "")?.[0];
    if (!d || f.status === "pominiety" || f.status === "zlozony") continue;
    const day = d.replace(/-/g, "");
    const next = new Date(d + "T00:00:00Z"); next.setUTCDate(next.getUTCDate() + 1);
    const p = f.program;
    lines.push("BEGIN:VEVENT", `UID:${f.id.replace(/[^\w.-]/g, "")}-${day}@dotacjo.pl`, `DTSTAMP:${dt(stamp)}`,
      `DTSTART;VALUE=DATE:${day}`, `DTEND;VALUE=DATE:${next.toISOString().slice(0, 10).replace(/-/g, "")}`,
      fold(`SUMMARY:${icsText("Koniec naboru: " + p.name)}`),
      fold(`DESCRIPTION:${icsText([p.op, p.url, f.note].filter(Boolean).join("\n"))}`),
      ...(p.url ? [fold(`URL:${p.url}`)] : []),
      "BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:-P14D", fold(`DESCRIPTION:${icsText("Za 14 dni koniec naboru: " + p.name)}`), "END:VALARM",
      "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

export function createProfile({ db, cfg, auth, stripe, log = console }) {
  const router = express.Router();
  router.use(auth.requireUser);
  router.use((_req, res, next) => (res.set("Cache-Control", "private, no-store"), next()));

  const list = (userId) =>
    db.prepare("SELECT * FROM favorites WHERE user_id = ? ORDER BY created_at DESC").all(userId).map(row2fav);

  router.get("/favorites", (req, res) => res.json({ favorites: list(req.user.id), statuses: STATUSES }));

  // Zapis lub zmiana: {program?, status?, note?}. Nowy wpis wymaga karty programu.
  router.put("/favorites/:id", (req, res) => {
    const id = String(req.params.id).slice(0, 100);
    const { status, note } = req.body || {};
    if (status !== undefined && !STATUSES.includes(status)) return res.status(400).json({ error: "bad_status" });
    const program = req.body?.program === undefined ? undefined : cleanProgram(req.body.program);
    if (program === null) return res.status(400).json({ error: "bad_program" });
    const now = nowSec();
    const cur = db.prepare("SELECT * FROM favorites WHERE user_id = ? AND program_id = ?").get(req.user.id, id);
    if (!cur) {
      if (!program) return res.status(400).json({ error: "bad_program" });
      const n = db.prepare("SELECT COUNT(*) n FROM favorites WHERE user_id = ?").get(req.user.id).n;
      if (n >= MAX_FAVORITES) return res.status(409).json({ error: "too_many" });
      db.prepare(
        "INSERT INTO favorites (user_id, program_id, program, status, note, created_at, updated_at) VALUES (?,?,?,?,?,?,?)"
      ).run(req.user.id, id, JSON.stringify(program), status || "nowy", str(note, 2000) ?? null, now, now);
    } else {
      db.prepare("UPDATE favorites SET program = ?, status = ?, note = ?, updated_at = ? WHERE user_id = ? AND program_id = ?").run(
        program ? JSON.stringify(program) : cur.program, status || cur.status,
        note === undefined ? cur.note : str(note, 2000) ?? null, now, req.user.id, id
      );
    }
    res.json({ favorite: row2fav(db.prepare("SELECT * FROM favorites WHERE user_id = ? AND program_id = ?").get(req.user.id, id)) });
  });

  router.delete("/favorites/:id", (req, res) => {
    db.prepare("DELETE FROM favorites WHERE user_id = ? AND program_id = ?").run(req.user.id, String(req.params.id));
    res.json({ ok: true });
  });

  router.get("/favorites.ics", (req, res) => {
    res.set("Content-Type", "text/calendar; charset=utf-8")
      .set("Content-Disposition", 'attachment; filename="dotacjo-terminy.ics"')
      .send(favoritesIcs(list(req.user.id), cfg.appUrl));
  });

  // Ostatnie wyszukiwanie zapisuje strona główna; profil pozwala je powtórzyć jednym kliknięciem.
  router.get("/search", (req, res) => {
    const r = db.prepare("SELECT query, label, updated_at FROM search_profiles WHERE user_id = ?").get(req.user.id);
    res.json({ search: r ? { query: Object.fromEntries(new URLSearchParams(r.query)), label: r.label || "", updatedAt: r.updated_at } : null });
  });

  router.put("/search", (req, res) => {
    const q = req.body?.query;
    if (!q || typeof q !== "object" || !q.region || !q.form || !q.size) return res.status(400).json({ error: "bad_query" });
    const keys = ["region", "form", "size", "sector", "pkd", "goals", "person", "amount"];
    const query = new URLSearchParams(keys.filter((k) => q[k] != null && q[k] !== "").map((k) => [k, String(q[k]).slice(0, 200)])).toString();
    db.prepare(
      `INSERT INTO search_profiles (user_id, query, label, updated_at) VALUES (?,?,?,?)
       ON CONFLICT(user_id) DO UPDATE SET query = excluded.query, label = excluded.label, updated_at = excluded.updated_at`
    ).run(req.user.id, query, str(req.body.label, 300) ?? null, nowSec());
    res.json({ ok: true });
  });

  // Alerty e-mail (nowe nabory + przypomnienia o terminach); działają przy abonamencie.
  router.get("/alerts", (req, res) => {
    const access = getAccess(db, cfg, req.user.id);
    res.json({ enabled: alertsEnabled(db, req.user.id), included: access.active && access.kind === "subscription" });
  });
  router.put("/alerts", (req, res) => {
    setAlertsEnabled(db, req.user.id, !!req.body?.enabled);
    res.json({ enabled: alertsEnabled(db, req.user.id) });
  });

  // RODO: kopia wszystkich danych konta w JSON.
  router.get("/export", (req, res) => {
    const id = req.user.id;
    const rows = (sql) => db.prepare(sql).all(id);
    const data = {
      exportedAt: new Date().toISOString(),
      account: { email: req.user.email, createdAt: new Date(req.user.created_at * 1000).toISOString() },
      subscriptions: rows("SELECT plan, status, current_period_end, cancel_at_period_end FROM subscriptions WHERE user_id = ?"),
      weekPasses: rows("SELECT plan, starts_at, ends_at, amount, revoked_at FROM passes WHERE user_id = ?"),
      consents: rows("SELECT kind, product, created_at FROM consents WHERE user_id = ?"),
      favorites: list(id),
      savedSearch: db.prepare("SELECT query, label, updated_at FROM search_profiles WHERE user_id = ?").get(id) || null,
      alerts: { enabled: alertsEnabled(db, id) },
      note: "Dane płatności (karta, faktury) przechowuje Stripe; faktury pobierzesz w panelu płatności.",
    };
    res.set("Content-Disposition", 'attachment; filename="dotacjo-moje-dane.json"').json(data);
  });

  // RODO: usunięcie konta. Wymaga wpisania własnego e-maila. Abonament jest anulowany od razu w Stripe;
  // historia płatności zostaje bez danych osobowych (obowiązek podatkowy), konto i ulubione znikają.
  router.post("/delete", async (req, res) => {
    const id = req.user.id;
    if (String(req.body?.confirm || "").trim().toLowerCase() !== req.user.email.toLowerCase())
      return res.status(400).json({ error: "confirm_mismatch" });
    const subs = db.prepare(
      "SELECT id FROM subscriptions WHERE user_id = ? AND status IN ('active','trialing','past_due','incomplete')"
    ).all(id);
    for (const s of subs) {
      try {
        await stripe.subscriptions.cancel(s.id);
      } catch (e) {
        if (e?.code !== "resource_missing") {
          log.error?.("Nie anulowano abonamentu przy usuwaniu konta", s.id, e.message);
          return res.status(502).json({ error: "stripe_cancel_failed" });
        }
      }
    }
    db.exec("BEGIN");
    try {
      for (const t of ["favorites", "search_profiles", "alert_settings", "alert_seen", "alert_reminders", "sessions"])
        db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(id);
      db.prepare("UPDATE subscriptions SET status = 'canceled', updated_at = ? WHERE user_id = ? AND status != 'canceled'").run(nowSec(), id);
      db.prepare("UPDATE consents SET ip = NULL WHERE user_id = ?").run(id);
      db.prepare("DELETE FROM login_tokens WHERE email = ?").run(req.user.email);
      db.prepare("UPDATE users SET email = ?, stripe_customer_id = NULL WHERE id = ?").run(`usuniety-${id}@usuniete.invalid`, id);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    res.clearCookie("dm_session", { path: "/" }).json({ ok: true });
  });

  return router;
}
