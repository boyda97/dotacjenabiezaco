import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import Stripe from "stripe";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
import { createApp } from "../src/app.js";

const WHSEC = "whsec_test_secret";
const cfg = loadConfig({
  appUrl: "http://localhost",
  dbPath: ":memory:",
  stripeWebhookSecret: WHSEC,
  prices: { start: "price_start", pro: "price_pro", biuro: "price_biuro", week: "price_week" },
});
const db = openDb(":memory:");
const sent = [];
const mailer = { sendLoginLink: async (email, link) => sent.push({ email, link }) };

// Prawdziwy klient Stripe (podpisy webhooków), z podmienionymi wywołaniami API.
const stripe = new Stripe("sk_test_dummy");
const created = [];
stripe.customers.create = async (p) => ({ id: "cus_" + p.metadata.userId });
stripe.checkout.sessions.create = async (p) => (created.push(p), { url: "https://checkout.stripe.test/s" });
stripe.billingPortal.sessions.create = async () => ({ url: "https://billing.stripe.test/p" });

const PROGRAMS = [
  { id: 1, name: "Bon na start", url: "https://x/1", type: "dotacja", max: 45000, deadline: "2026-11-30" },
  { id: 2, name: "Ekspansja", url: "https://x/2", type: "pozyczka", max: 300000, deadline: "2026-12-15" },
];
const lookupCompany = async (nip) =>
  nip === "5260250995" ? { name: "Firma testowa", region: "mazowieckie", form: null } : null;
const app = createApp({ db, cfg, stripe, mailer, loadPrograms: async () => PROGRAMS, lookupCompany, log: {} });
let server, base;
before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const post = (path, body, cookie) =>
  fetch(base + path, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
const get = (path, cookie) => fetch(base + path, { headers: cookie ? { Cookie: cookie } : {} });

async function login(email) {
  sent.length = 0;
  const r = await post("/api/auth/request", { email, next: "/#cennik" });
  assert.equal(r.status, 200);
  const token = new URL(sent[0].link).searchParams.get("token");
  const v = await fetch(base + "/api/auth/verify", {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "token=" + token,
  });
  assert.equal(v.status, 303);
  assert.equal(v.headers.get("location"), "/#cennik");
  return { cookie: v.headers.get("set-cookie").split(";")[0], token };
}

function webhook(type, object, id = "evt_" + Math.random().toString(36).slice(2)) {
  const payload = JSON.stringify({ id, type, data: { object } });
  const sig = stripe.webhooks.generateTestHeaderString({ payload, secret: WHSEC });
  return fetch(base + "/api/stripe/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Stripe-Signature": sig },
    body: payload,
  });
}
const userId = (email) => db.prepare("SELECT id FROM users WHERE email=?").get(email).id;
const inDays = (d) => Math.floor(Date.now() / 1000) + d * 86400;

test("link logowania zakłada konto, działa raz, GET go nie zużywa", async () => {
  const { cookie, token } = await login("Anna@Firma.pl");
  const me = await (await get("/api/me", cookie)).json();
  assert.equal(me.user.email, "anna@firma.pl");
  assert.equal(me.access.active, false);

  // drugi raz ten sam token -> odrzucony
  const again = await fetch(base + "/api/auth/verify", {
    method: "POST", redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "token=" + token,
  });
  assert.match(again.headers.get("location"), /login=expired/);

  // GET (np. skaner poczty) tylko wyświetla stronę
  const { token: t2 } = { token: (await login("gosc@firma.pl")).token };
  assert.equal((await get("/api/auth/verify?token=" + t2)).status, 200);
});

test("nieprawidłowy e-mail i obcy Origin są odrzucane", async () => {
  assert.equal((await post("/api/auth/request", { email: "nie-email" })).status, 400);
  const r = await fetch(base + "/api/auth/request", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
    body: JSON.stringify({ email: "a@b.pl" }),
  });
  assert.equal(r.status, 403);
});

test("bez dostępu: lista programów zablokowana poza pierwszym, szczegóły 402", async () => {
  const anon = await (await get("/api/programs")).json();
  assert.equal(anon.locked, true);
  assert.equal(anon.programs[0].name, "Bon na start");
  assert.equal(anon.programs[1].name, undefined);
  assert.equal(anon.programs[1].url, undefined);
  assert.equal(anon.programs[1].max, 300000);
  assert.equal((await get("/api/programs/2")).status, 402);
});

test("checkout wymaga logowania i zgód; tydzień oferuje BLIK i P24", async () => {
  assert.equal((await post("/api/billing/checkout", { product: "pro" })).status, 401);
  const { cookie } = await login("tydzien@firma.pl");
  assert.equal((await post("/api/billing/checkout", { product: "week" }, cookie)).status, 400);

  const r = await post("/api/billing/checkout", { product: "week", acceptTerms: true, immediateAccess: true }, cookie);
  assert.equal(r.status, 200);
  const p = created.at(-1);
  assert.equal(p.mode, "payment");
  assert.deepEqual(p.payment_method_types, ["card", "blik", "p24"]);
  assert.equal(p.metadata.product, "week");
  assert.match(p.invoice_creation.invoice_data.footer, /zwolniony z VAT/);

  await post("/api/billing/checkout", { product: "pro", acceptTerms: true, immediateAccess: true }, cookie);
  assert.equal(created.at(-1).mode, "subscription");
  assert.equal(created.at(-1).line_items[0].price, "price_pro");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM consents WHERE user_id=?").get(userId("tydzien@firma.pl")).n, 4);
});

test("webhook: zły podpis odrzucony", async () => {
  const r = await fetch(base + "/api/stripe/webhook", {
    method: "POST", headers: { "Content-Type": "application/json", "Stripe-Signature": "t=1,v1=zly" }, body: "{}",
  });
  assert.equal(r.status, 400);
});

test("tydzień: płatność daje 7 dni, kolejny tydzień przedłuża, zwrot odbiera dostęp", async () => {
  const { cookie } = await login("pass@firma.pl");
  const uid = userId("pass@firma.pl");
  const session = (id, pi) => ({
    id, mode: "payment", payment_status: "paid", payment_intent: pi, amount_total: 3900,
    client_reference_id: String(uid), metadata: { userId: String(uid), product: "week" },
  });

  // P24 może przyjść jako "unpaid" + async_payment_succeeded
  await webhook("checkout.session.completed", { ...session("cs_1", "pi_1"), payment_status: "unpaid" });
  assert.equal((await (await get("/api/me", cookie)).json()).access.active, false);
  assert.equal((await webhook("checkout.session.async_payment_succeeded", session("cs_1", "pi_1"))).status, 200);

  let me = await (await get("/api/me", cookie)).json();
  assert.equal(me.access.kind, "week");
  assert.equal(me.access.plan, "pro");
  assert.ok(Math.abs(me.access.until - inDays(7)) < 5);

  // ten sam event drugi raz -> bez zmian (idempotencja)
  await webhook("checkout.session.completed", session("cs_1", "pi_1"), "evt_dup");
  await webhook("checkout.session.completed", session("cs_1", "pi_1"), "evt_dup");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM passes WHERE user_id=?").get(uid).n, 1);

  // drugi tydzień doklejony na koniec pierwszego
  await webhook("checkout.session.completed", session("cs_2", "pi_2"));
  me = await (await get("/api/me", cookie)).json();
  assert.ok(Math.abs(me.access.until - inDays(14)) < 5);

  const full = await (await get("/api/programs", cookie)).json();
  assert.equal(full.locked, false);
  assert.equal(full.programs[1].url, "https://x/2");

  await webhook("charge.refunded", { refunded: true, payment_intent: "pi_1" });
  await webhook("charge.refunded", { refunded: true, payment_intent: "pi_2" });
  assert.equal((await (await get("/api/me", cookie)).json()).access.active, false);
});

test("subskrypcja: aktywna daje dostęp, past_due ma 3 dni karencji, anulowana odcina", async () => {
  const { cookie } = await login("sub@firma.pl");
  const uid = userId("sub@firma.pl");
  db.prepare("UPDATE users SET stripe_customer_id='cus_sub' WHERE id=?").run(uid);
  // brak metadata – użytkownik znajdowany po customer id; okres na pozycji (API 2025+)
  const sub = (status, end, extra = {}) => ({
    id: "sub_1", customer: "cus_sub", status, cancel_at_period_end: false, metadata: {},
    items: { data: [{ price: { id: "price_biuro" }, current_period_end: end }] }, ...extra,
  });

  await webhook("customer.subscription.created", sub("active", inDays(30)));
  let me = await (await get("/api/me", cookie)).json();
  assert.deepEqual([me.access.kind, me.access.plan], ["subscription", "biuro"]);

  // drugi zakup subskrypcji zablokowany -> panel Stripe
  const r = await post("/api/billing/checkout", { product: "pro", acceptTerms: true, immediateAccess: true }, cookie);
  assert.equal(r.status, 409);
  assert.equal((await (await post("/api/billing/portal", {}, cookie)).json()).url, "https://billing.stripe.test/p");

  await webhook("customer.subscription.updated", sub("past_due", inDays(-1)));
  assert.equal((await (await get("/api/me", cookie)).json()).access.active, true);
  await webhook("customer.subscription.updated", sub("past_due", inDays(-4)));
  assert.equal((await (await get("/api/me", cookie)).json()).access.active, false);

  await webhook("customer.subscription.updated", sub("active", inDays(20), { cancel_at_period_end: true }));
  me = await (await get("/api/me", cookie)).json();
  assert.equal(me.access.cancelAtPeriodEnd, true);
  await webhook("customer.subscription.deleted", sub("canceled", inDays(20)));
  assert.equal((await (await get("/api/me", cookie)).json()).access.active, false);
});

test("dane firmy po NIP: zły NIP 400, brak w rejestrze null", async () => {
  assert.equal((await get("/api/company?nip=1234567890")).status, 400);
  assert.deepEqual(await (await get("/api/company?nip=526-025-09-95")).json(), {
    company: { name: "Firma testowa", region: "mazowieckie", form: null },
  });
  assert.deepEqual(await (await get("/api/company?nip=8943235399")).json(), { company: null });
});

test("wylogowanie usuwa sesję", async () => {
  const { cookie } = await login("out@firma.pl");
  await post("/api/auth/logout", {}, cookie);
  assert.equal((await (await get("/api/me", cookie)).json()).user, null);
});

const put = (path, body, cookie) =>
  fetch(base + path, { method: "PUT", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify(body) });

test("profil: ulubione wymagają logowania, zapis, etap, notatka, usuwanie", async () => {
  assert.equal((await get("/api/profile/favorites")).status, 401);
  const { cookie } = await login("ulubione@firma.pl");
  assert.equal((await put("/api/profile/favorites/x", { status: "nowy" }, cookie)).status, 400); // nowy wpis bez karty
  assert.equal((await put("/api/profile/favorites/x", { program: { name: "A" }, status: "zly" }, cookie)).status, 400);

  const r = await put("/api/profile/favorites/bon-1", {
    program: { name: "Bon na start", url: "javascript:alert(1)", max: "45000", deadline: "2026-11-30", hack: 1 },
  }, cookie);
  assert.equal(r.status, 200);
  const { favorite } = await r.json();
  assert.equal(favorite.status, "nowy");
  assert.equal(favorite.program.url, undefined);
  assert.equal(favorite.program.max, 45000);
  assert.equal(favorite.program.hack, undefined);

  await put("/api/profile/favorites/bon-1", { status: "przygotowuje", note: "zebrać oferty" }, cookie);
  let favs = (await (await get("/api/profile/favorites", cookie)).json()).favorites;
  assert.equal(favs.length, 1);
  assert.equal(favs[0].status, "przygotowuje");
  assert.equal(favs[0].note, "zebrać oferty");
  assert.equal(favs[0].program.name, "Bon na start");

  const ics = await get("/api/profile/favorites.ics", cookie);
  assert.match(ics.headers.get("content-type"), /text\/calendar/);
  const body = await ics.text();
  assert.match(body, /DTSTART;VALUE=DATE:20261130/);
  assert.match(body, /DTEND;VALUE=DATE:20261201/);
  assert.match(body, /TRIGGER:-P14D/);
  assert.ok(body.split("\r\n").every((l) => Buffer.byteLength(l) <= 75));

  // cudze konto nie widzi ulubionych
  const { cookie: other } = await login("inny@firma.pl");
  assert.equal((await (await get("/api/profile/favorites", other)).json()).favorites.length, 0);

  await fetch(base + "/api/profile/favorites/bon-1", { method: "DELETE", headers: { Cookie: cookie } });
  favs = (await (await get("/api/profile/favorites", cookie)).json()).favorites;
  assert.equal(favs.length, 0);
});

test("profil: zapisane wyszukiwanie", async () => {
  const { cookie } = await login("szukam@firma.pl");
  assert.equal((await (await get("/api/profile/search", cookie)).json()).search, null);
  assert.equal((await put("/api/profile/search", { query: { region: "mazowieckie" } }, cookie)).status, 400);
  await put("/api/profile/search", { query: { region: "mazowieckie", form: "jdg", size: "micro", goals: "digital", evil: "x" }, label: "Moja firma" }, cookie);
  const { search } = await (await get("/api/profile/search", cookie)).json();
  assert.deepEqual(search.query, { region: "mazowieckie", form: "jdg", size: "micro", goals: "digital" });
  assert.equal(search.label, "Moja firma");
});
