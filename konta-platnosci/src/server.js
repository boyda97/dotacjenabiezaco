import Stripe from "stripe";
import { loadConfig } from "./config.js";
import { openDb } from "./db.js";
import { createMailer } from "./mailer.js";
import { createApp } from "./app.js";
import { createSilnikLoader } from "./silnik.js";

const cfg = loadConfig();
if (!cfg.stripeSecretKey || !cfg.stripeWebhookSecret) {
  console.error("Brak STRIPE_SECRET_KEY lub STRIPE_WEBHOOK_SECRET – uzupełnij plik .env (patrz README).");
  process.exit(1);
}

const db = openDb(cfg.dbPath);
const stripe = new Stripe(cfg.stripeSecretKey);
// Silnik dopasowania (katalog z pakietem Pythona dotacjomat), np. SILNIK_DIR=../silnik
const loadPrograms = process.env.SILNIK_DIR
  ? createSilnikLoader({ dir: process.env.SILNIK_DIR, python: process.env.SILNIK_PYTHON || "python3" })
  : undefined;
const app = createApp({ db, cfg, stripe, mailer: createMailer(cfg), loadPrograms });

// Sprzątanie wygasłych sesji i tokenów raz na godzinę
setInterval(() => {
  const now = Math.floor(Date.now() / 1000);
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(now);
  db.prepare("DELETE FROM login_tokens WHERE expires_at < ?").run(now - 86400);
}, 3600_000).unref();

app.listen(cfg.port, () => console.log(`Dotacje na Bieżąco działa na ${cfg.appUrl} (port ${cfg.port})`));
