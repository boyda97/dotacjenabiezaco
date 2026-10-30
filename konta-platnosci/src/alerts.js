// Alerty e-mail dla abonentów (obiecane w cenniku): raz w tygodniu (poniedziałek rano) jeden e-mail z
//  - nowymi naborami pasującymi do zapisanego wyszukiwania,
//  - naborami z ulubionych, które kończą się w ciągu 14 dni (każdy tylko raz).
// Ustalone z Kacprem 2026-10-30: najwyżej 4–5 e-maili w miesiącu, nie codziennie.
// Dostęp tygodniowy alertów nie obejmuje. Wypisanie: przełącznik w profilu albo link w e-mailu.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getAccess, nowSec } from "./entitlements.js";
import { getMeta, setMeta } from "./db.js";

const REMIND_DAYS = 14;
const MAX_NEW = 10;

// Data i godzina w Polsce (serwer działa w UTC).
export function warsawNow(d = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Warsaw", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23", weekday: "short" })
      .formatToParts(d).map((x) => [x.type, x.value])
  );
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday); // 0 = niedziela, 1 = poniedziałek
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), weekday };
}

const addDays = (day, n) => {
  const d = new Date(day + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const plDate = (iso) => iso.split("-").reverse().join(".");
const zl = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " zł";

function secret(db) {
  let s = getMeta(db, "alert_secret");
  if (!s) setMeta(db, "alert_secret", (s = randomBytes(32).toString("hex")));
  return s;
}
export const unsubscribeToken = (db, userId) => createHmac("sha256", secret(db)).update(`off:${userId}`).digest("base64url");
export function checkUnsubscribe(db, userId, token) {
  const a = Buffer.from(unsubscribeToken(db, userId)), b = Buffer.from(String(token || ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function alertsEnabled(db, userId) {
  return (db.prepare("SELECT enabled FROM alert_settings WHERE user_id = ?").get(userId)?.enabled ?? 1) === 1;
}
export function setAlertsEnabled(db, userId, enabled) {
  db.prepare(
    `INSERT INTO alert_settings (user_id, enabled, updated_at) VALUES (?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`
  ).run(userId, enabled ? 1 : 0, nowSec());
}

export function renderAlert({ appUrl, reminders, fresh, unsubscribeUrl }) {
  const lines = ["Dzień dobry,", ""];
  if (reminders.length) {
    lines.push(reminders.length === 1 ? "w ciągu dwóch tygodni kończy się nabór z Twoich ulubionych:" : "w ciągu dwóch tygodni kończą się nabory z Twoich ulubionych:", "");
    for (const r of reminders) {
      lines.push(`• ${r.program.name}`, `  koniec naboru: ${plDate(r.deadline)} (za ${r.daysLeft} ${r.daysLeft === 1 ? "dzień" : "dni"})`);
      if (r.program.url) lines.push(`  ${r.program.url}`);
      lines.push("");
    }
  }
  if (fresh.length) {
    lines.push(fresh.length === 1 ? "w tym tygodniu pojawił się nowy nabór pasujący do Twojej firmy:" : `w tym tygodniu pojawiły się nowe nabory pasujące do Twojej firmy (${fresh.length}):`, "");
    for (const p of fresh) {
      const bits = [p.deadline ? `nabór do ${plDate(p.deadline)}` : "nabór ciągły", p.max ? `do ${zl(p.max)}` : "", p.level || ""].filter(Boolean);
      lines.push(`• ${p.name}`, `  ${[p.op, ...bits].filter(Boolean).join(" · ")}`);
      if (p.url) lines.push(`  ${p.url}`);
      lines.push("");
    }
  }
  lines.push(`Wszystkie wyniki i ulubione: ${appUrl}/panel`, "",
    "Dotacjo · dotacjo.pl",
    `Nie chcesz tych wiadomości? Wypisz się jednym kliknięciem: ${unsubscribeUrl}`);
  return lines.join("\n");
}

function subject(reminders, fresh) {
  if (reminders.length && !fresh.length)
    return reminders.length === 1 ? `Za ${reminders[0].daysLeft} dni koniec naboru: ${reminders[0].program.name}`.slice(0, 120) : `Kończą się nabory z Twoich ulubionych (${reminders.length})`;
  if (fresh.length && !reminders.length) return fresh.length === 1 ? "Nowy nabór dla Twojej firmy" : `${fresh.length} nowe nabory dla Twojej firmy`;
  return "Nowe nabory i zbliżające się terminy";
}

// Jeden przebieg dla wszystkich abonentów. loadPrograms(req) to ten sam silnik co /api/programs.
export async function runAlerts({ db, cfg, mailer, loadPrograms, now = new Date(), log = console }) {
  const today = warsawNow(now).day;
  const users = db.prepare(
    `SELECT DISTINCT u.id, u.email FROM users u JOIN subscriptions s ON s.user_id = u.id
     WHERE s.status IN ('active','trialing','past_due')`
  ).all();
  let sent = 0;
  for (const u of users) {
    const access = getAccess(db, cfg, u.id);
    if (!access.active || access.kind !== "subscription" || !alertsEnabled(db, u.id)) continue;
    try {
      // 1) Przypomnienia o terminach ulubionych (aktywne etapy, koniec w ciągu 14 dni).
      const reminders = [];
      for (const f of db.prepare("SELECT program_id, program, status FROM favorites WHERE user_id = ?").all(u.id)) {
        if (f.status === "zlozony" || f.status === "pominiety") continue;
        const program = JSON.parse(f.program);
        const deadline = /^\d{4}-\d{2}-\d{2}/.exec(program.deadline || "")?.[0];
        if (!deadline || deadline < today || deadline > addDays(today, REMIND_DAYS)) continue;
        if (db.prepare("SELECT 1 FROM alert_reminders WHERE user_id = ? AND program_id = ? AND deadline = ?").get(u.id, f.program_id, deadline)) continue;
        const daysLeft = Math.round((Date.parse(deadline) - Date.parse(today)) / 864e5);
        reminders.push({ id: f.program_id, program, deadline, daysLeft });
      }

      // 2) Nowe nabory dla zapisanego wyszukiwania. Pierwszy przebieg tylko zapamiętuje stan (bez e-maila z całą listą).
      let fresh = [];
      const search = db.prepare("SELECT query FROM search_profiles WHERE user_id = ?").get(u.id);
      if (search) {
        const programs = (await loadPrograms({ query: Object.fromEntries(new URLSearchParams(search.query)), user: u }))
          .filter((p) => p.status !== "closed" && p.id != null);
        const known = db.prepare("SELECT COUNT(*) n FROM alert_seen WHERE user_id = ?").get(u.id).n > 0;
        const isSeen = db.prepare("SELECT 1 FROM alert_seen WHERE user_id = ? AND program_id = ?");
        const unseen = programs.filter((p) => !isSeen.get(u.id, String(p.id)));
        if (known) fresh = unseen.slice(0, MAX_NEW);
        const mark = db.prepare("INSERT OR IGNORE INTO alert_seen (user_id, program_id, seen_at) VALUES (?,?,?)");
        for (const p of unseen) mark.run(u.id, String(p.id), nowSec());
      }

      if (!reminders.length && !fresh.length) continue;
      const unsubscribeUrl = `${cfg.appUrl}/api/alerts/off?u=${u.id}&t=${unsubscribeToken(db, u.id)}`;
      await mailer.send({
        to: u.email, from: cfg.alertsFrom, subject: subject(reminders, fresh),
        text: renderAlert({ appUrl: cfg.appUrl, reminders, fresh, unsubscribeUrl }),
        headers: { "List-Unsubscribe": `<${unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
      });
      const done = db.prepare("INSERT OR IGNORE INTO alert_reminders (user_id, program_id, deadline, sent_at) VALUES (?,?,?,?)");
      for (const r of reminders) done.run(u.id, r.id, r.deadline, nowSec());
      db.prepare("INSERT INTO alert_log (user_id, sent_at, fresh, reminders) VALUES (?,?,?,?)").run(u.id, nowSec(), fresh.length, reminders.length);
      sent++;
    } catch (e) {
      log.error?.(`Alert dla użytkownika ${u.id} nieudany`, e);
    }
  }
  return sent;
}

// Uruchamia alerty raz w tygodniu: w dniu cfg.alertsWeekday (1 = poniedziałek) od cfg.alertsHour czasu polskiego.
export function scheduleAlerts(deps, everyMs = 15 * 60_000) {
  const { db, cfg, log = console } = deps;
  if (!cfg.alertsHour) return null;
  let running = false;
  const tick = async () => {
    const { day, hour, weekday } = warsawNow();
    if (running || weekday !== cfg.alertsWeekday || hour < cfg.alertsHour || getMeta(db, "alerts_last_day") === day) return;
    running = true;
    try {
      setMeta(db, "alerts_last_day", day);
      const n = await runAlerts(deps);
      log.info?.(`Alerty ${day}: wysłano ${n}`);
    } catch (e) {
      log.error?.("Alerty nieudane", e);
    } finally {
      running = false;
    }
  };
  return setInterval(tick, everyMs).unref();
}
