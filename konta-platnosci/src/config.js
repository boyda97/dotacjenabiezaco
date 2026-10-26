// Konfiguracja z zmiennych środowiskowych (patrz .env.example).
const env = process.env;

export function loadConfig(overrides = {}) {
  const cfg = {
    port: Number(env.PORT || 3000),
    appUrl: (env.APP_URL || "http://localhost:3000").replace(/\/$/, ""),
    dbPath: env.DB_PATH || "./data/dotacjenabiezaco.db",
    production: env.NODE_ENV === "production",

    // Sesja i link logowania
    sessionDays: Number(env.SESSION_DAYS || 30),
    loginTokenMinutes: Number(env.LOGIN_TOKEN_MINUTES || 20),

    // E-mail (Resend). Bez klucza linki logowania lądują w logach serwera (tryb dev).
    resendApiKey: env.RESEND_API_KEY || "",
    mailFrom: env.MAIL_FROM || "Dotacje na Bieżąco <logowanie@dotacjenabiezaco.pl>",

    // Stripe
    stripeSecretKey: env.STRIPE_SECRET_KEY || "",
    stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET || "",
    stripeAutomaticTax: env.STRIPE_AUTOMATIC_TAX === "1",
    prices: {
      start: env.STRIPE_PRICE_START || "",
      pro: env.STRIPE_PRICE_PRO || "",
      biuro: env.STRIPE_PRICE_BIURO || "",
      week: env.STRIPE_PRICE_WEEK || "",
    },
    // Jaki zakres funkcji daje tygodniowy dostęp jednorazowy
    weekPassPlan: env.WEEK_PASS_PLAN || "pro",
    weekPassDays: Number(env.WEEK_PASS_DAYS || 7),
    // Ile dni dostępu zostawiamy, gdy płatność odnowienia się nie powiodła (Stripe ponawia próby)
    pastDueGraceDays: Number(env.PAST_DUE_GRACE_DAYS || 3),
    ...overrides,
  };
  cfg.prices = { ...cfg.prices, ...(overrides.prices || {}) };
  return cfg;
}

export const SUBSCRIPTION_PLANS = ["start", "pro", "biuro"];
export const PRODUCTS = [...SUBSCRIPTION_PLANS, "week"];
