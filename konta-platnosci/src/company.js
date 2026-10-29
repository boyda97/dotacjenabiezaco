// Dane firmy po NIP z Białej Listy MF (publiczne API, bez klucza). Biała Lista obejmuje tylko
// podatników VAT, więc firmy zwolnione z VAT dostają pusty wynik i wypełniają formularz same.
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

export function createCompanyLookup({ fetchImpl = fetch, timeoutMs = 8000 } = {}) {
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
