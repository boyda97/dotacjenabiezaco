import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import express from "express";
import { createSilnikLoader, profileFromQuery } from "../src/silnik.js";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db.js";

const python = fileURLToPath(new URL("./fixtures/fake-python.sh", import.meta.url));

test("silnik: profil z query, spłaszczenie wyniku, przycięcie dla nieopłaconych, zły profil -> 400", async () => {
  assert.deepEqual(profileFromQuery({ region: "dolnoslaskie", form: "jdg", size: "micro", goals: "sprzet, marketing", amount: "50000" }), {
    region: "dolnoslaskie", form: "jdg", size: "micro", sector: undefined, pkd: undefined,
    goals: ["sprzet", "marketing"], person: [], amount: 50000,
  });

  const app = createApp({
    db: openDb(":memory:"), cfg: loadConfig({ dbPath: ":memory:" }), stripe: {}, mailer: {},
    loadPrograms: createSilnikLoader({ dir: ".", python }), log: {},
  });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const r = await (await fetch(base + "/api/programs?region=dolnoslaskie&form=jdg&size=micro")).json();
    assert.equal(r.locked, true);
    assert.equal(r.programs[0].name, "Bon");
    assert.equal(r.programs[0].score, 91);
    assert.deepEqual(r.programs[1], { id: "parp:ab12", type: "pozyczka", deadline: null, max: 300000, score: 64, locked: true });

    assert.equal((await fetch(base + "/api/programs?region=dolnoslaskie&form=jdg&size=mikro")).status, 400);
    assert.deepEqual((await (await fetch(base + "/api/programs")).json()).programs, []);
  } finally {
    server.close();
  }
});
