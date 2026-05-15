import { config } from "../config.ts";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface EmailTransport {
  send(msg: EmailMessage): Promise<void>;
}

/** Default transport when nothing is configured. Logs a redacted preview so
 * operators see what would be sent without leaking redeemable URLs. */
export class LogEmailTransport implements EmailTransport {
  async send(msg: EmailMessage): Promise<void> {
    console.log(
      `[email/log] to=${msg.to} subject=${JSON.stringify(msg.subject)}\n${redactSecrets(msg.text)}`,
    );
  }
}

// Strip review-action token URLs (`<base>/r/<token>` or `/r/<token>`) so
// operators see something happened without leaking redeemable links.
function redactSecrets(body: string): string {
  return body.replace(
    /(?:https?:\/\/[^\s<>"']*)?\/r\/[A-Za-z0-9_-]+(\?[^\s<>"']*)?/g,
    (_m, query: string | undefined) => {
      const action = query?.match(/[?&]action=([^&]+)/)?.[1];
      return action ? `<redacted review URL action=${action}>` : "<redacted review URL>";
    },
  );
}

export class ResendEmailTransport implements EmailTransport {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async send(msg: EmailMessage): Promise<void> {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: this.from,
        to: [msg.to],
        subject: msg.subject,
        text: msg.text,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "<no body>");
      throw new Error(`resend: ${res.status} ${body}`);
    }
  }
}

let testOverride: EmailTransport | null = null;

/**
 * Resolve the active transport from env each call — config getters are lazy,
 * and tests may mutate `Bun.env` between cases. `_setEmailTransportForTests`
 * takes precedence so tests don't need to set env at all.
 */
export function getEmailTransport(): EmailTransport {
  if (testOverride) return testOverride;
  if (config.email.transport === "resend") {
    return new ResendEmailTransport(config.email.resendApiKey, config.email.from);
  }
  return new LogEmailTransport();
}

export function _setEmailTransportForTests(t: EmailTransport | null): void {
  testOverride = t;
}
