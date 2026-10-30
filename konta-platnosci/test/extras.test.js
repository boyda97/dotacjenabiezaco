// Alerty e-mail, RODO (eksport i usunięcie konta), statystyka /admin, strony województw.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import Stripe from "stripe";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
import { createApp } from "../src/app.js";
import { runAlerts, warsawNow } from "../src/alerts.js";

const cfg = loadConfig({ appUrl: "http://localhost", dbPath: ":memory:", adminEmails: ["szef@dotacjo.pl"] });
const db = openDb(":memory:");
const links = [], mails = [];
const mailer = {
  sendLoginLink: async (email, link) => links.push({ email, link }),
  send: async (m) => mails.push(m),
};
const stripe = new Stripe("sk_test_dummy");
const canceled = [];
stripe.subscriptions.cancel = async (id) => (canceled.push(id), { id, status: "canceled" });

const day = (n) => {
  const d = new Date(warsawNow().day + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
let PROGRAMS = [
  { id: "parp:1", name: "Bon na cyfryzację", op: "PARP", url: "https://parp.example/1", type: "dotacja", status: "open", deadline: day(40), max: 85000, goals: ["digital"], regions: null },
  { id: "rpo:2", name: "Regionalna pożyczka", op: "BGK", url: "https://bgk.example/2", type: "pozyczka", status: "soon", deadline: day(90), goals: ["sprzet"], regions: ["mazowieckie"] },
  { id: "rpo:3", name: "Stary nabór", op: "X", url: "https://x/3", status: "closed", deadline: day(-3), regions: null },
];
const app = createApp({
  db, cfg, stripe, mailer, log: {},
  loadPrograms: async () => PROGRAMS,
  catalog: async () => PROGRAMS,
});
let server, base;
before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const req = (method, path, body, cookie, headers = {}) => fetch(base + path, {
  method, redirect: "manual",
  headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
  body: body !== undefined ? JSON.stringify(body) : undefined,
});
async function login(email) {
  links.length = 0;
  await req("POST", "/api/auth/request", { email });
  const token = new URL(links[0].link).searchParams.get("token");
  const v = await fetch(base + "/api/auth/verify", {
    method: "POST", redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "token=" + token,
  });
  return v.headers.get("set-cookie").split(";")[0];
}
const uid = (email) => db.prepare("SELECT id FROM users WHERE email = ?").get(email)?.id;
const subscribe = (id, userId) => db.prepare(
  "INSERT INTO subscriptions (id, user_id, plan, status, current_period_end, updated_at) VALUES (?,?,?,?,?,?)"
).run(id, userId, "start", "active", Math.floor(Date.now() / 1000) + 30 * 86400, 0);

test("alerty: przypomnienie 14 dni przed końcem, nowe nabory od drugiego przebiegu, wypisanie linkiem", async () => {
  const cookie = await login("abonent@firma.pl");
  subscribe("sub_alert", uid("abonent@firma.pl"));
  await req("PUT", "/api/profile/favorites/fav:1", { program: { name: "Ulubiony nabór", deadline: day(10), url: "https://u/1" } }, cookie);
  await req("PUT", "/api/profile/favorites/fav:2", { program: { name: "Złożony", deadline: day(5) }, status: "zlozony" }, cookie);
  await req("PUT", "/api/profile/favorites/fav:3", { program: { name: "Daleki", deadline: day(60) } }, cookie);
  await req("PUT", "/api/profile/search", { query: { region: "mazowieckie", form: "jdg", size: "micro" } }, cookie);
  // bez abonamentu: nie dostaje nic
  const other = await login("tydzien@firma.pl");
  await req("PUT", "/api/profile/favorites/fav:1", { program: { name: "Ulubiony nabór", deadline: day(10) } }, other);

  mails.length = 0;
  assert.equal(await runAlerts({ db, cfg, mailer, loadPrograms: async () => PROGRAMS, log: {} }), 1);
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to, "abonent@firma.pl");
  assert.match(mails[0].text, /Ulubiony nabór/);
  assert.doesNotMatch(mails[0].text, /Złożony|Daleki|Bon na cyfryzację/); // pierwszy przebieg: tylko stan wyjściowy
  assert.match(mails[0].headers["List-Unsubscribe"], /\/api\/alerts\/off\?u=\d+&t=/);

  // drugi dzień: przypomnienie się nie powtarza, nowy nabór trafia do e-maila (zamknięte pomijamy)
  PROGRAMS = [...PROGRAMS, { id: "nowy:4", name: "Nowy grant", op: "NFOŚiGW", url: "https://n/4", status: "open", deadline: day(30), max: 100000 },
    { id: "nowy:5", name: "Też zamknięty", status: "closed", deadline: day(-1) }];
  mails.length = 0;
  assert.equal(await runAlerts({ db, cfg, mailer, loadPrograms: async () => PROGRAMS, log: {} }), 1);
  assert.match(mails[0].text, /Nowy grant/);
  assert.doesNotMatch(mails[0].text, /Ulubiony nabór|Też zamknięty/);
  assert.equal(mails[0].subject, "Nowy nabór dla Twojej firmy");

  // wypisanie linkiem z e-maila, zły podpis odrzucony
  const url = new URL(mails[0].headers["List-Unsubscribe"].slice(1, -1));
  assert.equal((await fetch(base + url.pathname + "?u=" + url.searchParams.get("u") + "&t=zly")).status, 400);
  assert.equal((await fetch(base + url.pathname + url.search)).status, 200);
  assert.deepEqual(await (await req("GET", "/api/profile/alerts", undefined, cookie)).json(), { enabled: false, included: true });
  PROGRAMS = [...PROGRAMS, { id: "nowy:6", name: "Kolejny", status: "open" }];
  mails.length = 0;
  assert.equal(await runAlerts({ db, cfg, mailer, loadPrograms: async () => PROGRAMS, log: {} }), 0);

  // włączenie z powrotem w profilu
  await req("PUT", "/api/profile/alerts", { enabled: true }, cookie);
  assert.equal(await runAlerts({ db, cfg, mailer, loadPrograms: async () => PROGRAMS, log: {} }), 1);
});

test("RODO: eksport danych i usunięcie konta (abonament anulowany, ulubione usunięte, sesja wylogowana)", async () => {
  const cookie = await login("rodo@firma.pl");
  const id = uid("rodo@firma.pl");
  subscribe("sub_rodo", id);
  await req("PUT", "/api/profile/favorites/p1", { program: { name: "Coś" } }, cookie);

  const ex = await req("GET", "/api/profile/export", undefined, cookie);
  assert.match(ex.headers.get("content-disposition"), /dotacjo-moje-dane\.json/);
  const data = await ex.json();
  assert.equal(data.account.email, "rodo@firma.pl");
  assert.equal(data.favorites.length, 1);
  assert.equal(data.subscriptions[0].plan, "start");

  assert.equal((await req("POST", "/api/profile/delete", { confirm: "inny@firma.pl" }, cookie)).status, 400);
  assert.equal((await req("POST", "/api/profile/delete", { confirm: "RODO@firma.pl " }, cookie)).status, 200);
  assert.deepEqual(canceled, ["sub_rodo"]);
  assert.equal(uid("rodo@firma.pl"), undefined);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM favorites WHERE user_id = ?").get(id).n, 0);
  assert.equal(db.prepare("SELECT status FROM subscriptions WHERE id = 'sub_rodo'").get().status, "canceled");
  const me = await (await req("GET", "/api/me", undefined, cookie)).json();
  assert.equal(me.user, null);
  // ten sam e-mail może założyć nowe, czyste konto
  const again = await login("rodo@firma.pl");
  assert.notEqual(uid("rodo@firma.pl"), id);
  assert.equal((await (await req("GET", "/api/profile/favorites", undefined, again)).json()).favorites.length, 0);
});

test("statystyka: odsłony bez botów, unikalni, zdarzenia, panel tylko dla admina", async () => {
  const hit = (p, ua = "Mozilla/5.0", r = "https://www.google.com/search?q=dotacje") =>
    fetch(base + "/api/stats/hit", { method: "POST", headers: { "Content-Type": "text/plain", "User-Agent": ua }, body: JSON.stringify({ p, r }) });
  assert.equal((await hit("/")).status, 204);
  await hit("/dotacje/mazowieckie");
  await hit("/", "Googlebot/2.1");
  await hit("/<script>");
  await fetch(base + "/api/programs?region=mazowieckie&form=jdg&size=micro");

  assert.equal((await req("GET", "/api/stats/admin")).status, 401);
  const user = await login("zwykly@firma.pl");
  assert.equal((await req("GET", "/api/stats/admin", undefined, user)).status, 403);
  const admin = await login("szef@dotacjo.pl");
  const s = await (await req("GET", "/api/stats/admin", undefined, admin)).json();
  const today = s.daily.find((d) => d.day === warsawNow().day);
  assert.equal(today.odslony, 2);
  assert.equal(today.unikalni, 1);
  assert.ok(today.szukanie >= 1);
  assert.ok(today.logowanie >= 1);
  assert.deepEqual(s.refs[0], { k: "google.com", n: 2 });
  assert.ok(s.pages.some((p) => p.k === "/dotacje/mazowieckie"));
  assert.ok(s.totals.users >= 1);
});

test("strony województw: liczby i karty bez nazw, mapa strony, robots", async () => {
  const r = await fetch(base + "/dotacje/mazowieckie");
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /w województwie mazowieckim/);
  assert.match(html, /Pożyczka na sprzęt i maszyny/);
  assert.match(html, /<link rel="canonical" href="http:\/\/localhost\/dotacje\/mazowieckie">/);
  assert.doesNotMatch(html, /Bon na cyfryzację|parp\.example|Stary nabór/);

  const pom = await (await fetch(base + "/dotacje/pomorskie")).text();
  assert.doesNotMatch(pom, /Pożyczka na sprzęt/); // program tylko dla mazowieckiego
  assert.equal((await fetch(base + "/dotacje/atlantyda")).status, 404);
  assert.match(await (await fetch(base + "/dotacje")).text(), /href="\/dotacje\/zachodniopomorskie"/);
  assert.match(await (await fetch(base + "/sitemap.xml")).text(), /<loc>http:\/\/localhost\/dotacje\/slaskie<\/loc>/);
  assert.match(await (await fetch(base + "/robots.txt")).text(), /Disallow: \/api\//);
});
