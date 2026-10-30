import express from "express";
import { createAuth } from "./auth.js";
import { createBilling } from "./billing.js";
import { getAccess } from "./entitlements.js";
import { createProfile } from "./profile.js";
import { cleanNip, createCompanyLookup, validNip } from "./company.js";
import { checkUnsubscribe, setAlertsEnabled } from "./alerts.js";
import { createStats } from "./stats.js";
import { createSeo } from "./seo.js";
import { createAdmin } from "./admin.js";

// Pola programu widoczne bez opłaconego dostępu: wystarczą, żeby ocenić, czy warto odblokować
// (cel, region, kwota, poziom dofinansowania, termin), ale nie zdradzają nazwy, operatora ani linku.
const TEASER_FIELDS = ["id", "type", "status", "deadline", "max", "level", "regions", "goals", "requires", "requires_all", "score"];
const FREE_FULL_PROGRAMS = 1; // pierwszy program w pełni odblokowany (próbka)

export function createApp({
  db, cfg, stripe, mailer, loadPrograms = async () => [], lookupCompany = createCompanyLookup(), log = console,
  catalog = async () => [],
}) {
  const app = express();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  const auth = createAuth({ db, cfg, mailer, log });
  const billing = createBilling({ db, cfg, stripe, auth, log });

  // Webhook musi dostać surowe body (podpis), więc idzie przed parserem JSON.
  app.post("/api/stripe/webhook", ...billing.webhook);

  app.use(express.json({ limit: "100kb" }));
  app.use(express.urlencoded({ extended: false, limit: "10kb" }));

  // CSRF: zapytania zmieniające stan muszą przyjść z naszej domeny.
  app.use("/api", (req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD") return next();
    const origin = req.headers.origin;
    if (origin && origin !== cfg.appUrl) return res.status(403).json({ error: "bad_origin" });
    next();
  });

  app.use(auth.loadUser);
  const stats = createStats({ db, cfg });
  app.use("/api/stats", stats.router);
  // Liczniki zdarzeń do panelu /admin (bez danych osobowych).
  app.post("/api/auth/verify", (_req, _res, next) => (stats.event("logowanie"), next()));
  app.post("/api/billing/checkout", (_req, _res, next) => (stats.event("zakup_start"), next()));

  const requireAccess = (req, res, next) => {
    req.access = getAccess(db, cfg, req.user?.id);
    if (!req.access.active) return res.status(402).json({ error: "payment_required" });
    next();
  };

  app.use("/api/auth", auth.router);
  app.use("/api/billing", billing.router);
  app.use("/api/profile", createProfile({ db, cfg, auth, stripe, log }));
  app.use("/api/admin", createAdmin({ db, cfg, auth, catalog, mailer, loadPrograms, log }));

  // Wypisanie z alertów linkiem z e-maila (GET: przycisk potwierdzenia, POST: jedno kliknięcie w programie pocztowym).
  const unsubscribe = (req, res) => {
    const userId = Number(req.query.u);
    if (!userId || !checkUnsubscribe(db, userId, req.query.t)) return res.status(400).type("html").send("<p>Nieprawidłowy link.</p>");
    setAlertsEnabled(db, userId, false);
    if (req.method === "POST") return res.status(204).end();
    res.type("html").send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Wypisano z alertów – Dotacjo</title><body style="font:16px/1.6 system-ui;max-width:520px;margin:60px auto;padding:0 16px;color:#14211b">
<h1 style="font-size:24px">Wypisano z alertów</h1><p>Nie będziemy wysyłać e-maili o nowych naborach i terminach. Możesz je włączyć z powrotem w <a href="/profil" style="color:#006f3d">profilu</a>.</p></body>`);
  };
  app.get("/api/alerts/off", unsubscribe);
  app.post("/api/alerts/off", unsubscribe);

  app.get("/api/me", (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!req.user) return res.json({ user: null, access: { active: false } });
    res.json({
      user: { email: req.user.email, hasBilling: !!req.user.stripe_customer_id },
      access: getAccess(db, cfg, req.user.id),
    });
  });

  // Podpowiedź do formularza: nazwa, województwo, forma i branża z GUS albo Białej Listy MF (null, gdy brak).
  app.get("/api/company", async (req, res) => {
    if (!validNip(req.query.nip)) return res.status(400).json({ error: "bad_nip" });
    let company = null;
    try {
      company = await lookupCompany(cleanNip(req.query.nip));
    } catch (e) {
      log.warn?.("Rejestr firm niedostępny", e.message);
    }
    res.set("Cache-Control", "private, max-age=3600").json({ company });
  });

  // Przykład blokady treści: wyniki dopasowania. Silnik dopasowania (osobny moduł)
  // podłącza się przez loadPrograms(req); tutaj tylko odcinamy dane nieopłaconym.
  app.get("/api/programs", async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    const programs = await loadPrograms(req);
    if (req.query.region) stats.event("szukanie");
    const access = getAccess(db, cfg, req.user?.id);
    if (access.active) return res.json({ locked: false, access, programs });
    res.json({
      locked: true,
      access,
      programs: programs.map((p, i) =>
        i < FREE_FULL_PROGRAMS
          ? p
          : { ...Object.fromEntries(TEASER_FIELDS.filter((k) => k in p).map((k) => [k, p[k]])), locked: true }
      ),
    });
  });

  // Każdy inny płatny endpoint: app.get("/api/...", requireAccess, handler)
  app.get("/api/programs/:id", requireAccess, async (req, res) => {
    const p = (await loadPrograms(req)).find((x) => String(x.id) === req.params.id);
    if (!p) return res.status(404).json({ error: "not_found" });
    res.set("Cache-Control", "private, no-store").json(p);
  });

  app.use(createSeo({ cfg, catalog, log }));
  app.use(express.static("public", { extensions: ["html"] }));

  app.use((err, _req, res, _next) => {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    log.error?.(err);
    res.status(500).json({ error: "server_error" });
  });

  app.locals.requireAccess = requireAccess;
  return app;
}
