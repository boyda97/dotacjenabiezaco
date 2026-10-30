// Strony pod wyszukiwarki: /dotacje (lista województw) i /dotacje/:woj (nabory dla firm z województwa),
// plus /sitemap.xml i /robots.txt. Pokazują to samo co zablokowane karty (rodzaj, cel, kwota, termin),
// bez nazw i linków, które są w płatnym dostępie. Dane z silnika (`dotacjomat export -`), odświeżane co godzinę.
import { execFile } from "node:child_process";
import express from "express";

export const REGIONS = {
  dolnoslaskie: ["dolnośląskie", "dolnośląskim"], kujawsko: ["kujawsko-pomorskie", "kujawsko-pomorskim"],
  lubelskie: ["lubelskie", "lubelskim"], lubuskie: ["lubuskie", "lubuskim"], lodzkie: ["łódzkie", "łódzkim"],
  malopolskie: ["małopolskie", "małopolskim"], mazowieckie: ["mazowieckie", "mazowieckim"],
  opolskie: ["opolskie", "opolskim"], podkarpackie: ["podkarpackie", "podkarpackim"],
  podlaskie: ["podlaskie", "podlaskim"], pomorskie: ["pomorskie", "pomorskim"], slaskie: ["śląskie", "śląskim"],
  swietokrzyskie: ["świętokrzyskie", "świętokrzyskim"], warminsko: ["warmińsko-mazurskie", "warmińsko-mazurskim"],
  wielkopolskie: ["wielkopolskie", "wielkopolskim"], zachodniopomorskie: ["zachodniopomorskie", "zachodniopomorskim"],
};
const GOAL = { sprzet: "sprzęt i maszyny", budowa: "budowę i remont", nieruchomosc: "nieruchomości", pojazdy: "pojazdy",
  digital: "oprogramowanie i IT", ai: "automatyzację i AI", badania: "badania i rozwój", wzornictwo: "wzornictwo",
  ip: "ochronę patentową", oze: "energię odnawialną", efektywnosc: "oszczędzanie energii", goz: "recykling",
  szkolenia: "szkolenia", zatrudnienie: "zatrudnienie", doradztwo: "doradztwo", eksport: "eksport", marketing: "marketing",
  start: "założenie firmy", plynnosc: "bieżące wydatki" };
const TYPE = { dotacja: "Dotacja", pozyczka: "Pożyczka", mieszane: "Dotacja z pożyczką" };

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const zl = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " zł";
const plDate = (iso) => iso.split("-").reverse().join(".");
const year = () => new Date().getFullYear();

export function createCatalog({ dir, python = "python3", ttlMs = 3600_000 }) {
  let cache = { at: 0, data: [] };
  return async () => {
    if (Date.now() - cache.at < ttlMs) return cache.data;
    const out = await new Promise((resolve, reject) =>
      execFile(python, ["-m", "dotacjomat", "export", "-"], { cwd: dir, timeout: 30000, maxBuffer: 50 * 1024 * 1024 },
        (err, stdout) => (err ? reject(err) : resolve(stdout)))
    );
    cache = { at: Date.now(), data: JSON.parse(out) };
    return cache.data;
  };
}

export function forRegion(programs, slug) {
  return programs
    .filter((p) => p.status !== "closed" && (!p.regions || p.regions.includes(slug)))
    .sort((a, b) => (a.deadline || "9999").localeCompare(b.deadline || "9999"));
}

const CSS = `:root{--paper:#fbfcf8;--surface:#fff;--soft:#eef4ef;--greenL:#e6f5ec;--ink:#14211b;--mut:#5e6d66;--line:#e2e8e2;--green:#00854A;--deep:#003D2B;--greenT:#006f3d;--red:#c23b22;--font:"Plus Jakarta Sans",system-ui,-apple-system,"Segoe UI",sans-serif;color-scheme:light}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.6 var(--font)}
.wrap{max-width:1000px;margin:0 auto;padding:0 16px}a{color:var(--greenT)}
header{border-bottom:1px solid var(--line);background:var(--surface)}header .wrap{display:flex;align-items:center;justify-content:space-between;height:64px;gap:12px}
header img{display:block;width:140px;height:auto}.btn{display:inline-block;background:var(--green);color:#fff;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:12px}
.btn.sm{padding:9px 14px;font-size:14px}h1{font-size:clamp(28px,5vw,40px);line-height:1.15;margin:36px 0 12px;letter-spacing:-.02em}
.lead{color:var(--mut);font-size:18px;max-width:720px}.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:24px 0}
.stat{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:16px}.stat b{display:block;font-size:26px;color:var(--deep)}.stat span{color:var(--mut);font-size:14px}
.list{display:grid;gap:10px;margin:16px 0 28px;padding:0;list-style:none}.card{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:14px 16px;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}
.card h3{margin:0 0 4px;font-size:17px}.card p{margin:0;color:var(--mut);font-size:14px}.chip{align-self:flex-start;background:var(--greenL);color:var(--greenT);font-weight:700;font-size:13px;border-radius:999px;padding:4px 10px;white-space:nowrap}
.chip.soon{background:#fbe9e5;color:var(--red)}.cta{background:var(--deep);color:#fff;border-radius:18px;padding:24px;margin:28px 0}.cta h2{margin:0 0 6px}.cta p{color:#cfe3d8;margin:0 0 16px}
.cta .btn{background:#08D568;color:var(--deep)}.regions{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px;padding:0;list-style:none}
.regions a{display:flex;justify-content:space-between;background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:12px 14px;text-decoration:none;color:var(--ink);font-weight:600}
.regions a span{color:var(--mut);font-weight:500}h2{font-size:22px;margin:32px 0 8px}details{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:12px 16px;margin:8px 0}
summary{font-weight:700;cursor:pointer}footer{border-top:1px solid var(--line);margin-top:40px;padding:24px 0;color:var(--mut);font-size:13px;background:var(--surface)}`;

function page({ title, description, path, appUrl, body }) {
  return `<!doctype html><html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(description)}"><link rel="canonical" href="${appUrl}${path}">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}"><meta property="og:url" content="${appUrl}${path}"><meta property="og:type" content="website"><meta property="og:locale" content="pl_PL">
<link rel="icon" href="/brand/icons/favicon.svg" type="image/svg+xml"><meta name="theme-color" content="#003D2B">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap"><style>${CSS}</style></head>
<body><header><div class="wrap"><a href="/"><img src="/brand/svg/dotacjo-horizontal.svg" alt="Dotacjo" width="140" height="44"></a><a class="btn sm" href="/#top">Sprawdź swoją firmę</a></div></header>
<main class="wrap">${body}</main>
<footer><div class="wrap">© ${year()} Dotacjo · <a href="/dotacje">Dotacje według województw</a> · <a href="/#cennik">Cennik</a> · <a href="/#faq">Pytania</a><br>Informacje o naborach mają charakter pomocniczy; wiążący jest regulamin operatora programu.</div></footer>
<script src="/stat.js" defer></script></body></html>`;
}

function card(p) {
  const goals = (p.goals || []).filter((g) => GOAL[g]).slice(0, 3).map((g) => GOAL[g]);
  const title = `${TYPE[p.type] || "Wsparcie"}${goals.length ? " na " + goals.join(", ") : ""}`;
  const bits = [p.max ? `do ${zl(p.max)}` : "", p.level || "", p.regions ? "program regionalny" : "program ogólnopolski"].filter(Boolean);
  const chip = p.status === "soon" ? `<span class="chip soon">nabór wkrótce</span>`
    : p.deadline ? `<span class="chip">do ${plDate(p.deadline)}</span>` : `<span class="chip">nabór ciągły</span>`;
  return `<li class="card"><div><h3>${esc(title)}</h3><p>${esc(bits.join(" · "))}</p></div>${chip}</li>`;
}

export function createSeo({ cfg, catalog, log = console }) {
  const router = express.Router();
  const load = async () => {
    try {
      return await catalog();
    } catch (e) {
      log.warn?.("Katalog naborów niedostępny", e.message);
      return [];
    }
  };
  const html = (res, s) => res.set("Cache-Control", "public, max-age=1800").type("html").send(s);

  router.get("/dotacje", async (_req, res) => {
    const all = await load();
    const rows = Object.entries(REGIONS).map(([slug, [name]]) =>
      `<li><a href="/dotacje/${slug}">${esc(name)} <span>${forRegion(all, slug).length}</span></a></li>`).join("");
    html(res, page({
      appUrl: cfg.appUrl, path: "/dotacje",
      title: `Dotacje dla firm ${year()} według województw – aktualne nabory | Dotacjo`,
      description: `Aktualne nabory dotacji i pożyczek dla firm i osób zakładających działalność w każdym województwie. Sprawdzane codziennie, ułożone według terminu.`,
      body: `<h1>Dotacje dla firm ${year()} według województw</h1>
<p class="lead">Wybierz województwo, żeby zobaczyć, ile naborów dla firm trwa albo zaraz się zacznie. Liczba obok nazwy to nabory regionalne i ogólnopolskie razem.</p>
<ul class="regions">${rows}</ul>
<div class="cta"><h2>Nie wiesz, które pasują do Ciebie?</h2><p>Podaj województwo, formę i wielkość firmy. W minutę zobaczysz nabory, które pasują, ułożone według terminu.</p><a class="btn" href="/#top">Sprawdź swoją firmę za darmo</a></div>`,
    }));
  });

  router.get("/dotacje/:woj", async (req, res, next) => {
    const r = REGIONS[req.params.woj];
    if (!r) return next();
    const [name, loc] = r, slug = req.params.woj;
    const list = forRegion(await load(), slug);
    const open = list.filter((p) => p.status === "open"), soon = list.filter((p) => p.status === "soon");
    const regional = list.filter((p) => p.regions), starters = list.filter((p) => (p.goals || []).includes("start"));
    const top = Math.max(0, ...list.map((p) => p.max || 0));
    const shown = list.slice(0, 20).map(card).join("");
    html(res, page({
      appUrl: cfg.appUrl, path: `/dotacje/${slug}`,
      title: `Dotacje dla firm – ${name} ${year()}: aktualne nabory | Dotacjo`,
      description: `${list.length} aktualnych naborów dotacji i pożyczek dla firm w województwie ${loc}: ${open.length} trwa, ${soon.length} wkrótce. Sprawdź, które pasują do Twojej firmy.`,
      body: `<p><a href="/dotacje">← Wszystkie województwa</a></p>
<h1>Dotacje dla firm w województwie ${esc(loc)} (${year()})</h1>
<p class="lead">Nabory dotacji i pożyczek, z których mogą teraz skorzystać firmy z województwa ${esc(loc)}: programy regionalne i ogólnopolskie. Lista jest aktualizowana codziennie na podstawie oficjalnych ogłoszeń.</p>
<div class="stats"><div class="stat"><b>${open.length}</b><span>naborów trwa</span></div><div class="stat"><b>${soon.length}</b><span>startuje wkrótce</span></div>
<div class="stat"><b>${regional.length}</b><span>tylko dla regionu</span></div><div class="stat"><b>${starters.length}</b><span>dla zakładających firmę</span></div>
${top ? `<div class="stat"><b>${esc(top >= 1e6 ? `${String(Math.round(top / 1e5) / 10).replace(".", ",")} mln zł` : zl(top))}</b><span>najwyższa kwota</span></div>` : ""}</div>
<div class="cta"><h2>Które z nich pasują do Twojej firmy?</h2><p>Nie każdy nabór jest dla każdego: liczy się forma, wielkość firmy, branża i cel. Sprawdzimy to za Ciebie.</p><a class="btn" href="/?woj=${slug}#top">Sprawdź swoją firmę za darmo</a></div>
<h2>Nabory według terminu</h2>
${shown ? `<ul class="list">${shown}</ul>` : `<p>W tej chwili nie mamy otwartych naborów dla tego województwa. Sprawdzamy źródła codziennie.</p>`}
${list.length > 20 ? `<p>…i ${list.length - 20} kolejnych. Pełną listę z nazwami i linkami zobaczysz po sprawdzeniu firmy.</p>` : ""}
<h2>Pytania</h2>
<details><summary>Skąd są te informacje?</summary><p>Z oficjalnych harmonogramów i ogłoszeń instytucji, które prowadzą nabory (m.in. PARP, NFOŚiGW, instytucje regionalne). Sprawdzamy je codziennie.</p></details>
<details><summary>Dlaczego nie widzę nazw programów?</summary><p>Pełne karty z nazwą, instytucją i linkiem do regulaminu są w płatnym dostępie. Pierwszy pasujący program pokazujemy za darmo po sprawdzeniu firmy.</p></details>
<details><summary>Czy jako osoba bez firmy też coś znajdę?</summary><p>Tak. W wyszukiwarce wybierz „Zakładam firmę”. Pokażemy dotacje na start, np. z urzędu pracy, jeśli są dostępne w Twoim regionie.</p></details>`,
    }));
  });

  router.get("/robots.txt", (_req, res) =>
    res.type("text/plain").send(`User-agent: *\nDisallow: /api/\nDisallow: /panel\nDisallow: /profil\nDisallow: /admin\nSitemap: ${cfg.appUrl}/sitemap.xml\n`));

  router.get("/sitemap.xml", (_req, res) => {
    const urls = ["/", "/dotacje", ...Object.keys(REGIONS).map((s) => `/dotacje/${s}`)];
    res.type("application/xml").send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${
      urls.map((u) => `<url><loc>${cfg.appUrl}${u}</loc><changefreq>daily</changefreq></url>`).join("")}</urlset>\n`);
  });

  return router;
}
