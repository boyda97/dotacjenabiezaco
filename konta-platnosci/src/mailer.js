// Wysyłka e-maili przez Resend (https://resend.com). Bez klucza: wypisuje link w logach.
export function createMailer(cfg, log = console) {
  return {
    async sendLoginLink(email, link) {
      const subject = "Twój link do logowania – Dotacjo";
      const text =
        `Cześć!\n\nKliknij, aby zalogować się do serwisu Dotacjo:\n${link}\n\n` +
        `Link działa ${cfg.loginTokenMinutes} minut i tylko raz. ` +
        `Jeśli to nie Ty prosiłeś o logowanie, zignoruj tę wiadomość.\n\nDotacjo · dotacjo.pl\n`;
      if (!cfg.resendApiKey) {
        log.info?.(`[dev] link logowania dla ${email}: ${link}`);
        return;
      }
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.resendApiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: cfg.mailFrom, to: [email], subject, text }),
      });
      if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
    },
  };
}
