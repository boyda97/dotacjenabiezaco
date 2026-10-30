// Statystyka odwiedzin bez ciasteczek i bez zapisywania adresów IP: dzienne liczniki odsłon
// (strona + źródło wejścia) i liczba unikalnych osób, liczona skrótem IP+przeglądarki z dzienną solą
// trzymaną tylko w pamięci (po północy nie da się już powiązać wizyt). Odczyt: panel /admin (src/admin.js).
import { createHash, randomBytes } from "node:crypto";
import express from "express";
import { warsawNow } from "./alerts.js";

const BOT = /bot|crawl|spider|slurp|preview|monitor|curl|wget|python|headless|lighthouse/i;
const PATHS = /^\/[\w\-./]{0,80}$/;

export function createStats({ db, cfg }) {
  let salt = { day: "", value: "" }, seen = new Set();

  const bump = (day, name, n = 1) =>
    db.prepare(`INSERT INTO stat_daily (day, name, n) VALUES (?,?,?) ON CONFLICT(day, name) DO UPDATE SET n = n + excluded.n`)
      .run(day, name, n);

  function event(name) {
    bump(warsawNow().day, name);
  }

  function refHost(ref) {
    try {
      const h = new URL(ref).hostname.replace(/^www\./, "");
      return h && h !== new URL(cfg.appUrl).hostname.replace(/^www\./, "") ? h.slice(0, 60) : "";
    } catch {
      return "";
    }
  }

  function hit(req, path, ref) {
    const ua = req.headers["user-agent"] || "";
    if (BOT.test(ua) || !PATHS.test(path)) return;
    const { day } = warsawNow();
    if (salt.day !== day) (salt = { day, value: randomBytes(16).toString("hex") }), (seen = new Set());
    db.prepare(`INSERT INTO stat_views (day, path, ref, n) VALUES (?,?,?,1) ON CONFLICT(day, path, ref) DO UPDATE SET n = n + 1`)
      .run(day, path, refHost(ref));
    bump(day, "odslony");
    const visitor = createHash("sha256").update(`${salt.value}|${req.ip}|${ua}`).digest("hex").slice(0, 16);
    if (!seen.has(visitor)) seen.add(visitor), bump(day, "unikalni");
  }

  const router = express.Router();
  // Strony wysyłają {p: ścieżka, r: document.referrer} przez navigator.sendBeacon (text/plain).
  router.post("/hit", express.text({ limit: "2kb", type: "*/*" }), (req, res) => {
    try {
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
      hit(req, String(body.p || "/").split("?")[0], String(body.r || ""));
    } catch {}
    res.status(204).end();
  });

  return { router, event, hit };
}
