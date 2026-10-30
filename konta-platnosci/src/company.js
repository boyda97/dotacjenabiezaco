// Dane firmy po NIP. Najpierw GUS REGON (BIR 1.1, wymaga darmowego klucza GUS_KEY): obejmuje wszystkie
// firmy, także zwolnione z VAT, i podaje PKD. Bez klucza albo gdy GUS nie odpowiada: Biała Lista MF
// (publiczne API, bez klucza), która obejmuje tylko podatników VAT.
const POSTAL = [
  [0, 9, "mazowieckie"], [10, 14, "warminsko"], [15, 19, "podlaskie"], [20, 24, "lubelskie"],
  [25, 29, "swietokrzyskie"], [30, 34, "malopolskie"], [35, 39, "podkarpackie"], [40, 44, "slaskie"],
  [45, 49, "opolskie"], [50, 59, "dolnoslaskie"], [60, 64, "wielkopolskie"], [65, 69, "lubuskie"],
  [70, 78, "zachodniopomorskie"], [80, 84, "pomorskie"], [85, 89, "kujawsko"], [90, 99, "lodzkie"],
];

export const cleanNip = (s) => String(s || "").replace(/\D/g, "");

export function validNip(s) {
  const d = cleanNip(s);
  if (d.length !== 10) return false;
  const w = [6, 5, 7, 2, 3, 4, 5, 6, 7];
  const sum = w.reduce((acc, x, i) => acc + x * Number(d[i]), 0);
  return sum % 11 === Number(d[9]);
}

export function regionFromAddress(address) {
  const m = /\b(\d{2})-\d{3}\b/.exec(address || "");
  if (!m) return null;
  const p = Number(m[1]);
  return POSTAL.find(([lo, hi]) => p >= lo && p <= hi)?.[2] ?? null;
}

export function createMfLookup({ fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  return async (nip) => {
    const d = cleanNip(nip);
    const today = new Date().toISOString().slice(0, 10);
    const r = await fetchImpl(`https://wl-api.mf.gov.pl/api/search/nip/${d}?date=${today}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return null;
    const subj = (await r.json())?.result?.subject;
    if (!subj) return null;
    const address = subj.workingAddress || subj.residenceAddress || "";
    return {
      name: subj.name || null,
      region: regionFromAddress(address),
      // KRS mają spółki; brak KRS przy podatniku VAT to prawie zawsze JDG.
      form: subj.krs ? null : "jdg",
    };
  };
}

// ---- GUS REGON (BIR 1.1, SOAP) ----
const GUS_URL = {
  prod: "https://wyszukiwarkaregon.stat.gov.pl/wsBIR/UslugaBIRzewnPubl.svc",
  test: "https://wyszukiwarkaregontest.stat.gov.pl/wsBIR/UslugaBIRzewnPubl.svc",
};
export const GUS_TEST_KEY = "abcde12345abcde12345";

const unaccent = (s) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/ł/g, "l").replace(/Ł/g, "L");
const unxml = (s) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#xD;|&#13;/g, "")
    .replace(/&amp;/g, "&");
const tag = (xml, name) => unxml(new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1] || "").trim();

// „WARMIŃSKO-MAZURSKIE” -> „warminsko”, „ŚLĄSKIE” -> „slaskie” (te same wartości co w formularzu).
export function regionFromGus(woj) {
  const slug = unaccent(String(woj || "")).toLowerCase().split("-")[0].trim();
  return POSTAL.some(([, , r]) => r === slug) ? slug : null;
}

// Forma prawna z nazwy podmiotu prawnego (osoba fizyczna = JDG).
export function formFromName(name) {
  const n = unaccent(String(name || "")).toUpperCase();
  if (/PROSTA SPOLKA AKCYJNA|Z OGRANICZONA ODPOWIEDZIALNOSCIA|SP\. Z O\.O|SP\.Z O\.O/.test(n)) return "zoo";
  if (/SPOLKA AKCYJNA|KOMANDYTOW/.test(n)) return "sa";
  if (/JAWNA|PARTNERSK|CYWILNA|\bS\.C\./.test(n)) return "sc";
  if (/FUNDACJA|STOWARZYSZENIE/.test(n)) return "ngo";
  return null;
}

// Dział PKD 2007 -> branża z formularza (tylko te, które formularz zna).
export function sectorFromPkd(code) {
  const d = Number(String(code || "").replace(/\D/g, "").slice(0, 2));
  if (!d) return null;
  if (d === 10) return "C10";
  if (d === 79) return "N79";
  const S = [[1, 3, "A"], [10, 33, "C"], [35, 35, "D"], [36, 39, "E"], [41, 43, "F"], [45, 47, "G"], [49, 53, "H"],
    [55, 56, "I"], [58, 63, "J"], [69, 75, "M"], [77, 82, "N"], [85, 85, "P"], [86, 88, "Q"], [90, 93, "R"], [94, 96, "S"]];
  return S.find(([lo, hi]) => d >= lo && d <= hi)?.[2] ?? null;
}

const envelope = (url, action, body) => `<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:ns="http://CIS/BIR/PUBL/2014/07" xmlns:dat="http://CIS/BIR/PUBL/2014/07/DataContract">
<soap:Header xmlns:wsa="http://www.w3.org/2005/08/addressing"><wsa:To>${url}</wsa:To><wsa:Action>http://CIS/BIR/PUBL/2014/07/IUslugaBIRzewnPubl/${action}</wsa:Action></soap:Header>
<soap:Body>${body}</soap:Body></soap:Envelope>`;

export function createGusLookup({ key, fetchImpl = fetch, timeoutMs = 8000, sessionMinutes = 50 } = {}) {
  const url = key === GUS_TEST_KEY ? GUS_URL.test : GUS_URL.prod;
  let sid = null, sidAt = 0;

  async function call(action, body, withSid) {
    const r = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/soap+xml; charset=utf-8", ...(withSid ? { sid } : {}) },
      body: envelope(url, action, body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) throw new Error(`GUS ${action}: HTTP ${r.status}`);
    const text = await r.text();
    return unxml(new RegExp(`<${action}Result>([\\s\\S]*?)</${action}Result>`).exec(text)?.[1] || "");
  }

  async function login() {
    sid = await call("Zaloguj", `<ns:Zaloguj><ns:pKluczUzytkownika>${key}</ns:pKluczUzytkownika></ns:Zaloguj>`);
    if (!sid) throw new Error("GUS: logowanie nieudane (zły klucz?)");
    sidAt = Date.now();
  }

  async function withSession(action, body) {
    const fresh = !sid || Date.now() - sidAt > sessionMinutes * 60e3;
    if (fresh) await login();
    let out = await call(action, body, true);
    // Wygasła sesja daje pusty wynik: logujemy się raz jeszcze i powtarzamy.
    if (!out && !fresh) { await login(); out = await call(action, body, true); }
    return out;
  }

  return async (nip) => {
    const d = cleanNip(nip);
    const found = await withSession("DaneSzukajPodmioty",
      `<ns:DaneSzukajPodmioty><ns:pParametryWyszukiwania><dat:Nip>${d}</dat:Nip></ns:pParametryWyszukiwania></ns:DaneSzukajPodmioty>`);
    const dane = /<dane>([\s\S]*?)<\/dane>/.exec(found)?.[1];
    if (!dane || tag(dane, "ErrorCode")) return null;
    const typ = tag(dane, "Typ"), name = tag(dane, "Nazwa"), regon = tag(dane, "Regon");
    const company = {
      name: name || null,
      region: regionFromGus(tag(dane, "Wojewodztwo")) || regionFromAddress(tag(dane, "KodPocztowy")),
      form: typ === "F" ? "jdg" : formFromName(name),
    };
    // PKD (PKD 2007) do podpowiedzi branży; błąd raportu nie psuje reszty.
    try {
      const fiz = typ === "F";
      const raport = await withSession("DanePobierzPelnyRaport",
        `<ns:DanePobierzPelnyRaport><ns:pRegon>${regon}</ns:pRegon><ns:pNazwaRaportu>${fiz ? "BIR11OsFizycznaPkd" : "BIR11OsPrawnaPkd"}</ns:pNazwaRaportu></ns:DanePobierzPelnyRaport>`);
      const rows = raport.split("<dane>").slice(1);
      const kod = (r) => tag(r, fiz ? "fiz_pkd_Kod" : "praw_pkdKod");
      const main = rows.find((r) => tag(r, fiz ? "fiz_pkd_Przewazajace" : "praw_pkdPrzewazajace") === "1") || rows[0];
      if (main && kod(main)) {
        company.pkd = kod(main);
        const sector = sectorFromPkd(company.pkd);
        if (sector) company.sector = sector;
      }
    } catch {}
    return company;
  };
}

// GUS, a gdy nie ma klucza, nie odpowiada albo nie zna NIP-u: Biała Lista MF.
export function createCompanyLookup({ gusKey = "", fetchImpl = fetch, timeoutMs = 8000, log = console } = {}) {
  const mf = createMfLookup({ fetchImpl, timeoutMs });
  const gus = gusKey ? createGusLookup({ key: gusKey, fetchImpl, timeoutMs }) : null;
  return async (nip) => {
    if (gus) {
      try {
        const c = await gus(nip);
        if (c) return c;
      } catch (e) {
        log.warn?.("GUS niedostępny", e.message);
      }
    }
    return mf(nip);
  };
}
