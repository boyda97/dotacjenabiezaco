// Wysyłka e-maili przez Resend (https://resend.com). Bez klucza: wypisuje treść w logach.
export function createMailer(cfg, log = console) {
  async function send({ to, subject, text, from = cfg.mailFrom, headers }) {
    if (!cfg.resendApiKey) {
      log.info?.(`[dev] e-mail do ${to}: ${subject}\n${text}`);
      return;
    }
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.resendApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, text, ...(headers ? { headers } : {}) }),
    });
    if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
  }

  return {
    send,
    async sendLoginLink(email, link, code) {
      const text =
        `Cześć!\n\nKliknij, aby zalogować się do serwisu Dotacjo:\n${link}\n\n` +
        (code ? `Logujesz się w aplikacji na telefonie? Wpisz tam ten kod: ${code}\n\n` : "") +
        `Link i kod działają ${cfg.loginTokenMinutes} minut i tylko raz. ` +
        `Jeśli to nie Ty prosiłeś o logowanie, zignoruj tę wiadomość.\n\nDotacjo · dotacjo.pl\n`;
      if (!cfg.resendApiKey) {
        log.info?.(`[dev] link logowania dla ${email}: ${link}${code ? ` (kod ${code})` : ""}`);
        return;
      }
      await send({ to: email, subject: "Twój link do logowania – Dotacjo", text });
    },
  };
}
