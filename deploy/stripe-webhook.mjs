// Zakłada w Stripe webhook na APP_URL/api/stripe/webhook i wypisuje STRIPE_WEBHOOK_SECRET=...
// Stripe pokazuje sekret tylko przy tworzeniu, więc istniejący webhook pod tym adresem jest zastępowany.
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const url = `${(process.env.APP_URL || "https://dotacjo.pl").replace(/\/$/, "")}/api/stripe/webhook`;
const EVENTS = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "charge.refunded",
];

for await (const ep of stripe.webhookEndpoints.list({ limit: 100 })) {
  if (ep.url === url) await stripe.webhookEndpoints.del(ep.id);
}
const ep = await stripe.webhookEndpoints.create({ url, enabled_events: EVENTS, description: "Dotacjo" });
console.log(`STRIPE_WEBHOOK_SECRET=${ep.secret}`);
