import express from "express";
import { createAuth } from "./auth.js";
import { createBilling } from "./billing.js";
import { getAccess } from "./entitlements.js";

// Pola programu widoczne bez opłaconego dostępu – wystarczą do paska
// "N programów, łącznie X zł, najbliższy termin", ale nie zdradzają nazwy ani źródła.
const TEASER_FIELDS = ["id", "type", "status", "deadline", "max", "score"];
const FREE_FULL_PROGRAMS = 1; // pierwszy program w pełni odblokowany (próbka)

export function createApp({ db, cfg, stripe, mailer, loadPrograms = async () => [], log = console }) {
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

  const requireAccess = (req, res, next) => {
    req.access = getAccess(db, cfg, req.user?.id);
    if (!req.access.active) return res.status(402).json({ error: "payment_required" });
    next();
  };

  app.use("/api/auth", auth.router);
  app.use("/api/billing", billing.router);

  app.get("/api/me", (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!req.user) return res.json({ user: null, access: { active: false } });
    res.json({
      user: { email: req.user.email, hasBilling: !!req.user.stripe_customer_id },
      access: getAccess(db, cfg, req.user.id),
    });
  });

  // Przykład blokady treści: wyniki dopasowania. Silnik dopasowania (osobny moduł)
  // podłącza się przez loadPrograms(req); tutaj tylko odcinamy dane nieopłaconym.
  app.get("/api/programs", async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    const programs = await loadPrograms(req);
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

  app.use(express.static("public", { extensions: ["html"] }));

  app.use((err, _req, res, _next) => {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    log.error?.(err);
    res.status(500).json({ error: "server_error" });
  });

  app.locals.requireAccess = requireAccess;
  return app;
}
