import { test } from "node:test";
import assert from "node:assert/strict";
import { validNip, regionFromAddress, createCompanyLookup } from "../src/company.js";

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
