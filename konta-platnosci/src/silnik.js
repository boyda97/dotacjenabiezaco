// Most do silnika dopasowania (Python, /silnik): `python -m dotacjomat match --profile plik --json`.
// Profil firmy przychodzi w query: ?region=&form=&size=&sector=&pkd=&goals=a,b&person=x&amount=
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const list = (v) => (v ? String(v).split(",").map((s) => s.trim()).filter(Boolean) : []);
const str = (v) => (v == null || v === "" ? undefined : String(v).slice(0, 64));

export function profileFromQuery(q) {
  const amount = Number(q.amount);
  return {
    region: str(q.region),
    form: str(q.form),
    size: str(q.size),
    sector: str(q.sector),
    pkd: str(q.pkd),
    goals: list(q.goals),
    person: list(q.person),
    ...(Number.isFinite(amount) && amount > 0 ? { amount: Math.round(amount) } : {}),
  };
}

// Wynik silnika {program:{...}, score, why, ...} spłaszczamy do {...program, score, why, ...}.
export const flatten = (r) => ({ ...r.program, score: r.score, eligible: r.eligible, urgent: r.urgent,
  days_left: r.days_left, why: r.why });

export function createSilnikLoader({ dir, python = "python3", limit = 50, timeoutMs = 20000 }) {
  return async (req) => {
    const profile = profileFromQuery(req.query);
    if (!profile.region || !profile.form || !profile.size) return [];
    const tmp = await mkdtemp(join(tmpdir(), "dm-profil-"));
    const file = join(tmp, "profil.json");
    try {
      await writeFile(file, JSON.stringify(profile));
      const out = await new Promise((resolve, reject) =>
        execFile(
          python,
          ["-m", "dotacjomat", "match", "--profile", file, "--json", "--limit", String(limit)],
          { cwd: dir, timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024 },
          (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr })) : resolve(stdout))
        )
      );
      return JSON.parse(out).map(flatten);
    } catch (e) {
      // Nieznana wartość w profilu (np. size=mikro) -> 400 zamiast 500
      if (/Nieznana|ValueError/.test(e.stderr || "")) throw Object.assign(new Error("bad_profile"), { status: 400 });
      throw e;
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  };
}
