// vonBuschOS — Mail-Gatekeeper: Versand-Adapter (VON-1802 / K5)
//
// Baut eine simple RFC-822/2822 Nachricht (nur text/plain, UTF-8) und versendet sie über
// die CF `send_email`-Bindung. Der MIME-Bau ist rein & getestet; der reale Versand ist
// hinter dem `Mailer`-Interface gekapselt und in Tests injizierbar.

import type { EmailProposal } from "./approval-queue.ts";

export interface Mailer {
  send(msg: EmailProposal): Promise<{ id: string }>;
}

/** Quotet einen Header-Wert (RFC 2047) falls Nicht-ASCII vorkommt. Verhindert Header-Injection. */
export function encodeHeaderValue(value: string): string {
  const clean = value.replace(/[\r\n]+/g, " ");
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7E]*$/.test(clean)) return clean;
  const b64 = Buffer.from(clean, "utf-8").toString("base64");
  return `=?UTF-8?B?${b64}?=`;
}

/**
 * Baut eine vollständige RFC-822 Nachricht als String.
 * `messageId` wird als stabile Message-ID im Absender-Domain-Kontext gesetzt.
 */
export function buildMime(msg: EmailProposal, messageId: string): string {
  const domain = msg.from.split("@")[1] ?? "vonbusch.app";
  const headers = [
    `From: ${encodeHeaderValue(msg.from)}`,
    `To: ${encodeHeaderValue(msg.to)}`,
    `Subject: ${encodeHeaderValue(msg.subject)}`,
    `Message-ID: <${messageId}@${domain}>`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset="utf-8"`,
    `Content-Transfer-Encoding: base64`,
  ];
  // Body base64-kodiert in 76er-Zeilen — robust gegen UTF-8 & Zeilenenden.
  const b64 = Buffer.from(msg.text, "utf-8").toString("base64");
  const wrapped = b64.replace(/(.{76})/g, "$1\r\n");
  return headers.join("\r\n") + "\r\n\r\n" + wrapped + "\r\n";
}

/**
 * Realer Mailer über die CF `send_email`-Bindung.
 * `EmailMessage` und die Bindung stehen nur zur Laufzeit auf workerd zur Verfügung,
 * daher wird `cloudflare:email` dynamisch importiert (Tests laden diese Datei nicht).
 */
export function makeCloudflareMailer(binding: {
  send(message: unknown): Promise<void>;
}, newId: () => string = () => crypto.randomUUID()): Mailer {
  return {
    async send(msg: EmailProposal): Promise<{ id: string }> {
      const id = newId();
      const { EmailMessage } = (await import("cloudflare:email")) as {
        EmailMessage: new (from: string, to: string, raw: string) => unknown;
      };
      const raw = buildMime(msg, id);
      await binding.send(new EmailMessage(msg.from, msg.to, raw));
      return { id };
    },
  };
}
