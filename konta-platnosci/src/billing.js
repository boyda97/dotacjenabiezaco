// Płatności Stripe: subskrypcja miesięczna (Start/Pro/Biuro) i jednorazowy dostęp tygodniowy.
// Stan dostępu zmieniają WYŁĄCZNIE webhooki Stripe – nie strona powrotu z płatności.
import express, { Router } from "express";
import { SUBSCRIPTION_PLANS, PRODUCTS } from "./config.js";
import { tx } from "./db.js";
import { getAccess, hasActiveSubscription, passStart, nowSec } from "./entitlements.js";

export function createBilling({ db, cfg, stripe, auth, log = console }) {
  const planByPrice = () =>
    Object.fromEntries(SUBSCRIPTION_PLANS.map((p) => [cfg.prices[p], p]).filter(([k]) => k));

  async function ensureCustomer(user) {
    if (user.stripe_customer_id) return user.stripe_customer_id;
    const c = await stripe.customers.create({
      email: user.email,
      metadata: { userId: String(user.id) },
      preferred_locales: ["pl"],
      ...(cfg.invoiceFooter ? { invoice_settings: { footer: cfg.invoiceFooter } } : {}),
    });
    db.prepare("UPDATE users SET stripe_customer_id = ? WHERE id = ?").run(c.id, user.id);
    return c.id;
  }

  const router = Router();

  // Rozpoczęcie płatności -> zwraca URL do Stripe Checkout.
  router.post("/checkout", auth.requireUser, async (req, res) => {
    const product = String(req.body?.product || "");
    if (!PRODUCTS.includes(product)) return res.status(400).json({ error: "unknown_product" });
    if (!cfg.prices[product]) return res.status(500).json({ error: "price_not_configured" });

    // Zgody wymagane przy treściach cyfrowych (konsumenci i JDG: utrata prawa odstąpienia
    // po rozpoczęciu świadczenia wymaga wyraźnej zgody – art. 38 pkt 13 ustawy o prawach konsumenta).
    if (req.body?.acceptTerms !== true || req.body?.immediateAccess !== true) {
      return res.status(400).json({ error: "consent_required" });
    }

    const user = req.user;
    if (product !== "week" && hasActiveSubscription(db, user.id)) {
      return res.status(409).json({ error: "already_subscribed", hint: "use_portal" });
    }

    const insertConsent = db.prepare(
      "INSERT INTO consents (user_id, kind, product, ip, created_at) VALUES (?,?,?,?,?)"
    );
    insertConsent.run(user.id, "terms", product, req.ip, nowSec());
    insertConsent.run(user.id, "immediate_access_withdrawal_waiver", product, req.ip, nowSec());

    const customer = await ensureCustomer(user);
    const meta = { userId: String(user.id), product };
    const common = {
      customer,
      client_reference_id: String(user.id),
      line_items: [{ price: cfg.prices[product], quantity: 1 }],
      locale: "pl",
      metadata: meta,
      billing_address_collection: "required",
      customer_update: { name: "auto", address: "auto" },
      tax_id_collection: { enabled: true }, // NIP na fakturze
      success_url: `${cfg.appUrl}/panel?platnosc=ok`,
      cancel_url: `${cfg.appUrl}/?platnosc=anulowana#cennik`,
      ...(cfg.stripeAutomaticTax ? { automatic_tax: { enabled: true } } : {}),
    };

    const params =
      product === "week"
        ? {
            ...common,
            mode: "payment",
            // BLIK i Przelewy24 działają w Stripe tylko przy płatnościach jednorazowych.
            payment_method_types: ["card", "blik", "p24"],
            invoice_creation: {
              enabled: true,
              ...(cfg.invoiceFooter ? { invoice_data: { footer: cfg.invoiceFooter } } : {}),
            },
            payment_intent_data: { metadata: meta },
          }
        : {
            ...common,
            mode: "subscription",
            // Metody płatności cyklicznych (karta, Apple Pay, Google Pay, Link) wybiera
            // panel Stripe – nie podajemy payment_method_types.
            allow_promotion_codes: true,
            subscription_data: { metadata: meta },
          };

    const session = await stripe.checkout.sessions.create(params);
    res.json({ url: session.url });
  });

  // Panel klienta Stripe: zmiana karty, faktury, zmiana planu, anulowanie.
  router.post("/portal", auth.requireUser, async (req, res) => {
    if (!req.user.stripe_customer_id) return res.status(400).json({ error: "no_customer" });
    const s = await stripe.billingPortal.sessions.create({
      customer: req.user.stripe_customer_id,
      return_url: `${cfg.appUrl}/profil`,
      locale: "pl",
    });
    res.json({ url: s.url });
  });

  // ---------- Webhook ----------
  const userIdFor = (obj) => {
    const fromMeta = Number(obj.metadata?.userId || obj.client_reference_id);
    if (fromMeta) return fromMeta;
    const customer = typeof obj.customer === "string" ? obj.customer : obj.customer?.id;
    return db.prepare("SELECT id FROM users WHERE stripe_customer_id = ?").get(customer)?.id;
  };

  function grantPass(session) {
    if (session.metadata?.product !== "week" || session.payment_status !== "paid") return;
    const userId = userIdFor(session);
    if (!userId) throw new Error(`Brak użytkownika dla sesji ${session.id}`);
    if (db.prepare("SELECT 1 FROM passes WHERE id = ?").get(session.id)) return;
    const start = passStart(db, userId);
    db.prepare(
      `INSERT INTO passes (id, user_id, payment_intent, plan, starts_at, ends_at, amount)
       VALUES (?,?,?,?,?,?,?)`
    ).run(
      session.id, userId, session.payment_intent ?? null, cfg.weekPassPlan,
      start, start + cfg.weekPassDays * 86400, session.amount_total ?? null
    );
  }

  function upsertSubscription(sub) {
    const userId = userIdFor(sub);
    if (!userId) throw new Error(`Brak użytkownika dla subskrypcji ${sub.id}`);
    const item = sub.items?.data?.[0];
    const plan = planByPrice()[item?.price?.id] || sub.metadata?.product || "start";
    // Od API 2025-03 okres rozliczeniowy jest na pozycji subskrypcji, wcześniej na subskrypcji.
    const periodEnd = item?.current_period_end ?? sub.current_period_end ?? nowSec();
    db.prepare(
      `INSERT INTO subscriptions (id, user_id, plan, status, current_period_end, cancel_at_period_end, updated_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET plan=excluded.plan, status=excluded.status,
         current_period_end=excluded.current_period_end,
         cancel_at_period_end=excluded.cancel_at_period_end, updated_at=excluded.updated_at`
    ).run(sub.id, userId, plan, sub.status, periodEnd, sub.cancel_at_period_end ? 1 : 0, nowSec());
  }

  const handlers = {
    "checkout.session.completed": (o) => grantPass(o),
    // P24 i inne metody z opóźnionym potwierdzeniem
    "checkout.session.async_payment_succeeded": (o) => grantPass(o),
    "customer.subscription.created": upsertSubscription,
    "customer.subscription.updated": upsertSubscription,
    "customer.subscription.deleted": upsertSubscription,
    // Zwrot za tydzień (np. gwarancja zwrotu) -> odbieramy dostęp
    "charge.refunded": (charge) => {
      if (charge.refunded && charge.payment_intent) {
        db.prepare("UPDATE passes SET revoked_at = ? WHERE payment_intent = ? AND revoked_at IS NULL").run(
          nowSec(), charge.payment_intent
        );
      }
    },
  };

  const webhook = [
    express.raw({ type: "application/json" }),
    (req, res) => {
      let event;
      try {
        event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], cfg.stripeWebhookSecret);
      } catch (e) {
        log.warn?.("Odrzucony webhook Stripe:", e.message);
        return res.status(400).send("bad signature");
      }
      const handler = handlers[event.type];
      try {
        tx(db, () => {
          if (db.prepare("SELECT 1 FROM stripe_events WHERE id = ?").get(event.id)) return;
          handler?.(event.data.object);
          db.prepare("INSERT INTO stripe_events (id, type, processed_at) VALUES (?,?,?)").run(
            event.id, event.type, nowSec()
          );
        });
      } catch (e) {
        log.error?.(`Błąd obsługi ${event.type}`, e);
        return res.status(500).send("error"); // Stripe ponowi wysyłkę
      }
      res.json({ received: true });
    },
  ];

  return { router, webhook, access: (userId) => getAccess(db, cfg, userId) };
}
