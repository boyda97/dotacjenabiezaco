// Klient kont i płatności dla strony Dotacjo.
// Dołącz na końcu strony: <script src="/konto.js"></script>
// Udostępnia window.Konto oraz podmienia demo-funkcje login() i choosePlan() z obecnej strony.
(() => {
  const api = async (path, body) => {
    const r = await fetch(path, {
      method: body ? "POST" : "GET",
      credentials: "same-origin",
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(data.error || r.status), { status: r.status, data });
    return data;
  };

  // --- prosty modal (bez zależności) ---
  function modal(html) {
    const wrap = document.createElement("div");
    wrap.setAttribute("role", "dialog");
    wrap.setAttribute("aria-modal", "true");
    wrap.style.cssText =
      "position:fixed;inset:0;background:rgba(0,0,0,.45);display:grid;place-items:center;z-index:9999;padding:16px";
    wrap.innerHTML = `<div style="background:var(--bg,#fff);color:var(--ink,#111);max-width:420px;width:100%;border-radius:14px;padding:22px;font:15px/1.5 system-ui">${html}</div>`;
    wrap.addEventListener("click", (e) => e.target === wrap && wrap.remove());
    document.body.appendChild(wrap);
    return wrap;
  }

  function askEmail(next) {
    const m = modal(`<h3 style="margin:0 0 6px">Zaloguj się lub załóż konto</h3>
      <p style="margin:0 0 12px;opacity:.75">Wyślemy Ci link do logowania – bez hasła.</p>
      <form><input type="email" required placeholder="twoj@email.pl" autocomplete="email"
        style="width:100%;box-sizing:border-box;font:inherit;padding:10px;border:1px solid #ccc;border-radius:8px">
      <button class="btn" style="margin-top:10px;width:100%">Wyślij link</button><p data-msg style="margin:10px 0 0"></p></form>`);
    const form = m.querySelector("form");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const msg = form.querySelector("[data-msg]");
      try {
        await api("/api/auth/request", { email: form.querySelector("input").value, next });
        msg.textContent = "Sprawdź skrzynkę – link jest ważny 20 minut.";
      } catch (err) {
        msg.textContent = err.status === 429 ? "Za dużo prób, spróbuj za chwilę." : "Nie udało się wysłać linku.";
      }
    });
    form.querySelector("input").focus();
  }

  function askConsent(product) {
    return new Promise((resolve) => {
      const m = modal(`<h3 style="margin:0 0 10px">Zanim przejdziesz do płatności</h3>
        <label style="display:flex;gap:8px;margin-bottom:8px"><input type="checkbox" data-c="t">
          <span>Akceptuję <a href="/regulamin" target="_blank">Regulamin</a> i <a href="/prywatnosc" target="_blank">Politykę prywatności</a>.</span></label>
        <label style="display:flex;gap:8px"><input type="checkbox" data-c="i">
          <span>Proszę o natychmiastowy dostęp do treści cyfrowych i przyjmuję do wiadomości, że tracę prawo odstąpienia od umowy z chwilą rozpoczęcia świadczenia.</span></label>
        <button class="btn" style="margin-top:14px;width:100%" disabled>${product === "week" ? "Zapłać (BLIK, P24, karta)" : "Przejdź do płatności"}</button>`);
      const [t, i] = m.querySelectorAll("input");
      const b = m.querySelector("button");
      const upd = () => (b.disabled = !(t.checked && i.checked));
      t.onchange = i.onchange = upd;
      b.onclick = () => { m.remove(); resolve(true); };
    });
  }

  const Konto = {
    me: () => api("/api/me"),
    login: (next) => askEmail(next),
    async logout() { await api("/api/auth/logout", {}); location.href = "/"; },
    async checkout(product) {
      const { user } = await Konto.me();
      if (!user) return askEmail(`/?kup=${product}#cennik`);
      await askConsent(product);
      try {
        const { url } = await api("/api/billing/checkout", { product, acceptTerms: true, immediateAccess: true });
        location.href = url;
      } catch (err) {
        if (err.data?.hint === "use_portal") return Konto.portal(); // zmiana planu w panelu Stripe
        alert("Nie udało się rozpocząć płatności. Spróbuj ponownie.");
      }
    },
    async portal() { const { url } = await api("/api/billing/portal", {}); location.href = url; },
  };
  window.Konto = Konto;

  // --- integracja z obecną stroną (zastępuje tryb demo) ---
  window.login = () => Konto.login();
  window.choosePlan = (id) => Konto.checkout(id);
  window.logout = () => Konto.logout();

  document.addEventListener("DOMContentLoaded", async () => {
    const btn = document.getElementById("authBtn");
    let me = { user: null, access: { active: false } };
    try { me = await Konto.me(); } catch {}
    window.dotacjomatAccess = me.access;
    if (btn) {
      const fresh = btn.cloneNode(true); // usuwa demo-handler
      btn.replaceWith(fresh);
      fresh.textContent = me.user ? "Mój profil" : "Zaloguj";
      fresh.onclick = () => (me.user ? (location.href = "/profil") : Konto.login());
    }
    // Przyciski z panelu "Abonament"
    document.addEventListener("click", (e) => {
      const t = e.target.closest("button");
      if (t && /Pobierz faktury|Zmień kartę|Anuluj abonament/.test(t.textContent)) Konto.portal();
    });
    // Powrót po zalogowaniu z wybranym planem: ?kup=pro
    const kup = new URLSearchParams(location.search).get("kup");
    if (kup && me.user) Konto.checkout(kup);
    document.dispatchEvent(new CustomEvent("konto:ready", { detail: me }));
  });
})();
