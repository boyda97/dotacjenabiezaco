// Konfiguracja z zmiennych środowiskowych (patrz .env.example).
const env = process.env;

export function loadConfig(overrides = {}) {
  const cfg = {
    port: Number(env.PORT || 3000),
    appUrl: (env.APP_URL || "http://localhost:3000").replace(/\/$/, ""),
    dbPath: env.DB_PATH || "./data/dotacjo.db",
    production: env.NODE_ENV === "production",

    // Sesja i link logowania
    sessionDays: Number(env.SESSION_DAYS || 30),
    loginTokenMinutes: Number(env.LOGIN_TOKEN_MINUTES || 20),

    // E-mail (Resend). Bez klucza linki logowania lądują w logach serwera (tryb dev).
    resendApiKey: env.RESEND_API_KEY || "",
    mailFrom: env.MAIL_FROM || "Dotacjo <logowanie@dotacjo.pl>",
    alertsFrom: env.ALERTS_FROM || "Dotacjo <alerty@dotacjo.pl>",
    // Alerty e-mail: raz w tygodniu, w dniu ALERTS_WEEKDAY (1 = poniedziałek) od ALERTS_HOUR (czas polski). 0 = wyłączone.
    alertsHour: Number(env.ALERTS_HOUR ?? 7),
    alertsWeekday: Number(env.ALERTS_WEEKDAY ?? 1),

    // Adresy e-mail z dostępem do /admin (statystyki), po przecinku.
    adminEmails: (env.ADMIN_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),

    // Dane firmy po NIP z GUS REGON (darmowy klucz od GUS). Bez klucza tylko Biała Lista MF (firmy z VAT).
    gusKey: env.GUS_KEY || "",

    // Stripe
    stripeSecretKey: env.STRIPE_SECRET_KEY || "",
    stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET || "",
    stripeAutomaticTax: env.STRIPE_AUTOMATIC_TAX === "1",
    // Stopka faktur. Dopóki sprzedawca jest zwolniony z VAT, faktura musi podawać podstawę zwolnienia.
    invoiceFooter:
      env.INVOICE_FOOTER ?? "Sprzedawca zwolniony z VAT na podstawie art. 113 ust. 1 ustawy o VAT.",
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
