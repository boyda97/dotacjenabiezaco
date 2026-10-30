import { test } from "node:test";
import assert from "node:assert/strict";
import { validNip, regionFromAddress, createCompanyLookup, formFromName, regionFromGus, sectorFromPkd } from "../src/company.js";

test("NIP: suma kontrolna i myślniki", () => {
  assert.equal(validNip("526-025-09-95"), true);
  assert.equal(validNip("5260250994"), false);
  assert.equal(validNip("123"), false);
});

test("województwo z kodu pocztowego", () => {
  assert.equal(regionFromAddress("JODŁOWICKA 7A/1, 54-062 WROCŁAW"), "dolnoslaskie");
  assert.equal(regionFromAddress("AL. JEROZOLIMSKIE 160, 02-326 WARSZAWA"), "mazowieckie");
  assert.equal(regionFromAddress("bez kodu"), null);
});

test("Biała Lista: JDG bez KRS, brak firmy = null", async () => {
  const fake = (subject) => async () => ({ ok: true, json: async () => ({ result: { subject } }) });
  const jdg = await createCompanyLookup({ fetchImpl: fake({ name: "Jan", workingAddress: "ul. X 1, 30-001 Kraków" }) })("5260250995");
  assert.deepEqual(jdg, { name: "Jan", region: "malopolskie", form: "jdg" });
  const spolka = await createCompanyLookup({ fetchImpl: fake({ name: "S", krs: "1", residenceAddress: "80-001 Gdańsk" }) })("5260250995");
  assert.equal(spolka.form, null);
  assert.equal(await createCompanyLookup({ fetchImpl: fake(null) })("5260250995"), null);
});

// Odpowiedzi GUS jak z prawdziwego serwisu: wynik w środku SOAP, zakodowany jako tekst XML.
const soap = (action, inner) =>
  `--uuid\r\nContent-Type: application/xop+xml\r\n\r\n<s:Envelope><s:Body><${action}Response><${action}Result>${inner
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</${action}Result></${action}Response></s:Body></s:Envelope>\r\n--uuid--`;

function fakeGus({ dane, pkd }) {
  const calls = [];
  let logins = 0, dead = null;
  const fetchImpl = async (url, opt) => {
    const action = /IUslugaBIRzewnPubl\/(\w+)/.exec(opt.body)[1];
    calls.push({ url, action, sid: opt.headers.sid });
    let inner = "";
    if (action === "Zaloguj") inner = "sid" + ++logins;
    else if (opt.headers.sid === dead) inner = "";
    else if (action === "DaneSzukajPodmioty") inner = dane ? `<root><dane>${dane}</dane></root>` : `<root><dane><ErrorCode>4</ErrorCode></dane></root>`;
    else if (action === "DanePobierzPelnyRaport") inner = `<root>${pkd}</root>`;
    return { ok: true, text: async () => soap(action, inner) };
  };
  return { fetchImpl, calls, expire: () => (dead = "sid" + logins) };
}

test("GUS: JDG bez VAT z województwem i branżą z przeważającego PKD", async () => {
  const { fetchImpl, calls } = fakeGus({
    dane: "<Regon>528527490</Regon><Nip>8943235399</Nip><Nazwa>HOBBIT &amp; CO KACPER</Nazwa><Wojewodztwo>DOLNOŚLĄSKIE</Wojewodztwo><Typ>F</Typ>",
    pkd: "<dane><fiz_pkd_Kod>8551Z</fiz_pkd_Kod><fiz_pkd_Przewazajace>0</fiz_pkd_Przewazajace></dane>" +
      "<dane><fiz_pkd_Kod>6312Z</fiz_pkd_Kod><fiz_pkd_Przewazajace>1</fiz_pkd_Przewazajace></dane>",
  });
  const c = await createCompanyLookup({ gusKey: "k", fetchImpl })("8943235399");
  assert.deepEqual(c, { name: "HOBBIT & CO KACPER", region: "dolnoslaskie", form: "jdg", pkd: "6312Z", sector: "J" });
  assert.deepEqual(calls.map((x) => x.action), ["Zaloguj", "DaneSzukajPodmioty", "DanePobierzPelnyRaport"]);
  assert.equal(calls[1].sid, "sid1");
  assert.match(calls[0].url, /wyszukiwarkaregon\.stat/);
});

test("GUS: spółka z o.o., dwuczłonowe województwo, ponowne logowanie po wygaśnięciu sesji", async () => {
  const { fetchImpl, calls, expire } = fakeGus({
    dane: "<Regon>1</Regon><Nazwa>ABC SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ</Nazwa><Wojewodztwo>WARMIŃSKO-MAZURSKIE</Wojewodztwo><Typ>P</Typ>",
    pkd: "<dane><praw_pkdKod>1071Z</praw_pkdKod><praw_pkdPrzewazajace>1</praw_pkdPrzewazajace></dane>",
  });
  const look = createCompanyLookup({ gusKey: "k", fetchImpl, log: {} });
  await look("5260250995");
  expire();
  calls.length = 0;
  const c = await look("5260250995");
  assert.deepEqual(calls.map((x) => x.action), ["DaneSzukajPodmioty", "Zaloguj", "DaneSzukajPodmioty", "DanePobierzPelnyRaport"]);
  assert.equal(c.form, "zoo");
  assert.equal(c.region, "warminsko");
  assert.equal(c.sector, "C10");
});

test("GUS niedostępny albo nie zna NIP-u: Biała Lista MF", async () => {
  const mf = async (url) => url.includes("wl-api")
    ? { ok: true, json: async () => ({ result: { subject: { name: "Z VAT", workingAddress: "00-001 Warszawa" } } }) }
    : { ok: false, status: 503 };
  assert.deepEqual(await createCompanyLookup({ gusKey: "k", fetchImpl: mf, log: {} })("5260250995"),
    { name: "Z VAT", region: "mazowieckie", form: "jdg" });
});

test("formy i branże z GUS", () => {
  assert.equal(formFromName("XYZ PROSTA SPÓŁKA AKCYJNA"), "zoo");
  assert.equal(formFromName("XYZ SPÓŁKA AKCYJNA"), "sa");
  assert.equal(formFromName("KOWALSKI I NOWAK SPÓŁKA JAWNA"), "sc");
  assert.equal(formFromName("FUNDACJA DOBRA"), "ngo");
  assert.equal(regionFromGus("ŚLĄSKIE"), "slaskie");
  assert.equal(regionFromGus("KUJAWSKO-POMORSKIE"), "kujawsko");
  assert.equal(regionFromGus("ŁÓDZKIE"), "lodzkie");
  assert.equal(sectorFromPkd("7911A"), "N79");
  assert.equal(sectorFromPkd("6420Z"), null);
});
