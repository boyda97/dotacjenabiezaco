// Logowanie bez hasła: link z e-maila -> sesja w ciasteczku httpOnly.
// Pierwsze logowanie zakłada konto (rejestracja = logowanie).
import { createHash, randomBytes } from "node:crypto";
import { Router } from "express";
import { nowSec } from "./entitlements.js";

const COOKIE = "dm_session";
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const newToken = () => randomBytes(32).toString("base64url");

export function parseCookies(header = "") {
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Prosty limiter w pamięci (wystarczy na jedną instancję serwera).
function rateLimiter(limit, windowSec) {
  const hits = new Map();
  return (key) => {
    const now = nowSec();
    const arr = (hits.get(key) || []).filter((t) => t > now - windowSec);
    arr.push(now);
    hits.set(key, arr);
    return arr.length <= limit;
  };
}

// Tylko ścieżki względne w obrębie serwisu (ochrona przed open redirect).
const safeNext = (n) => (typeof n === "string" && /^\/(?!\/)[\w\-./?=&#%]*$/.test(n) ? n : "/profil");

export function createAuth({ db, cfg, mailer, log = console }) {
  const perEmail = rateLimiter(5, 3600);
  const perIp = rateLimiter(30, 3600);

  function findOrCreateUser(email) {
    const existing = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
    if (existing) return existing;
    db.prepare("INSERT INTO users (email, created_at) VALUES (?, ?)").run(email, nowSec());
    return db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  }

  function createSession(res, userId) {
    const id = newToken();
    const expires = nowSec() + cfg.sessionDays * 86400;
    db.prepare("INSERT INTO sessions (id_hash, user_id, expires_at, created_at) VALUES (?,?,?,?)").run(
      sha256(id), userId, expires, nowSec()
    );
    res.cookie(COOKIE, id, {
      httpOnly: true,
      secure: cfg.production,
      sameSite: "lax",
      path: "/",
      maxAge: cfg.sessionDays * 86400 * 1000,
    });
  }

  // Middleware: ustawia req.user, jeśli ciasteczko sesji jest ważne.
  function loadUser(req, _res, next) {
    const sid = parseCookies(req.headers.cookie)[COOKIE];
    if (sid) {
      const row = db
        .prepare(
          `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
           WHERE s.id_hash = ? AND s.expires_at > ?`
        )
        .get(sha256(sid), nowSec());
      if (row) req.user = row;
    }
    next();
  }

  function requireUser(req, res, next) {
    if (!req.user) return res.status(401).json({ error: "not_logged_in" });
    next();
  }

  const router = Router();

  // 1) Prośba o link. Zawsze 200 – nie zdradzamy, czy konto istnieje.
  router.post("/request", async (req, res) => {
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "invalid_email" });
    if (!perIp(req.ip) || !perEmail(email)) return res.status(429).json({ error: "too_many_requests" });

    const token = newToken();
    db.prepare("INSERT INTO login_tokens (token_hash, email, next, expires_at) VALUES (?,?,?,?)").run(
      sha256(token), email, safeNext(req.body?.next), nowSec() + cfg.loginTokenMinutes * 60
    );
    try {
      await mailer.sendLoginLink(email, `${cfg.appUrl}/api/auth/verify?token=${token}`);
    } catch (e) {
      log.error?.("Wysyłka e-maila nie powiodła się", e);
      return res.status(502).json({ error: "email_failed" });
    }
    res.json({ ok: true });
  });

  // 2) Kliknięcie w link. GET tylko pokazuje stronę, a token zużywa POST –
  // skanery poczty (Outlook, Gmail) otwierają linki i inaczej "zjadłyby" token.
  router.get("/verify", (req, res) => {
    const token = String(req.query.token || "").replace(/[^\w-]/g, "");
    res.type("html").send(`<!doctype html><html lang="pl"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Logowanie – Dotacjo</title>
<body style="font-family:system-ui;max-width:420px;margin:15vh auto;padding:0 16px;text-align:center">
<h1 style="font-size:22px">Logowanie do serwisu Dotacjo</h1>
<form method="post" action="/api/auth/verify"><input type="hidden" name="token" value="${token}">
<button style="font:inherit;font-size:16px;padding:12px 22px;border-radius:8px;border:0;background:#2f55ff;color:#fff;cursor:pointer">Zaloguj się</button></form>
<script>document.forms[0].submit()</script></body></html>`);
  });

  router.post("/verify", (req, res) => {
    const token = String(req.body?.token || "");
    const row = db.prepare("SELECT * FROM login_tokens WHERE token_hash = ?").get(sha256(token));
    if (!row || row.used_at || row.expires_at < nowSec()) {
      return res.redirect(303, "/?login=expired#panel");
    }
    db.prepare("UPDATE login_tokens SET used_at = ? WHERE token_hash = ?").run(nowSec(), row.token_hash);
    const user = findOrCreateUser(row.email);
    createSession(res, user.id);
    res.redirect(303, row.next || "/profil");
  });

  router.post("/logout", (req, res) => {
    const sid = parseCookies(req.headers.cookie)[COOKIE];
    if (sid) db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(sha256(sid));
    res.clearCookie(COOKIE, { path: "/" });
    res.json({ ok: true });
  });

  return { router, loadUser, requireUser, findOrCreateUser };
}
