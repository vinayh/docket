import { afterEach, describe, expect, test } from "bun:test";
import { setFetch } from "../../test/fetch.ts";
import {
  LogEmailTransport,
  ResendEmailTransport,
  _setEmailTransportForTests,
  getEmailTransport,
} from "./email.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  _setEmailTransportForTests(null);
  delete (Bun.env as Record<string, string | undefined>).MARGIN_EMAIL_TRANSPORT;
  delete (Bun.env as Record<string, string | undefined>).RESEND_API_KEY;
  delete (Bun.env as Record<string, string | undefined>).MARGIN_EMAIL_FROM;
});

describe("ResendEmailTransport", () => {
  test("POSTs to /emails with auth + json body, throws on non-2xx", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    setFetch(async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ id: "msg_1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const t = new ResendEmailTransport("rk_test", "Margin <hi@example.com>");
    await t.send({ to: "alice@example.com", subject: "hi", text: "body" });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.resend.com/emails");
    expect(calls[0]!.init?.method).toBe("POST");
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer rk_test");
    expect(headers["content-type"]).toBe("application/json");
    const body = JSON.parse(String(calls[0]!.init?.body));
    expect(body).toEqual({
      from: "Margin <hi@example.com>",
      to: ["alice@example.com"],
      subject: "hi",
      text: "body",
    });
  });

  test("rejects with status + body on error", async () => {
    setFetch(async () => new Response("nope", { status: 422 }));
    const t = new ResendEmailTransport("rk_test", "hi@example.com");
    await expect(
      t.send({ to: "alice@example.com", subject: "hi", text: "body" }),
    ).rejects.toThrow(/resend: 422 nope/);
  });
});

describe("LogEmailTransport", () => {
  test("redacts review-action URLs in logged body, preserving action label", async () => {
    const logs: string[] = [];
    const realLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    try {
      await new LogEmailTransport().send({
        to: "alice@example.com",
        subject: "hi",
        text: [
          "Open: https://margin.pub/r/mra_abc123?action=mark_reviewed",
          "Decline: https://margin.pub/r/mra_abc123?action=decline",
          "Relative: /r/mra_xyz789",
        ].join("\n"),
      });
    } finally {
      console.log = realLog;
    }
    const joined = logs.join("\n");
    expect(joined).not.toContain("mra_abc123");
    expect(joined).not.toContain("mra_xyz789");
    expect(joined).toContain("<redacted review URL action=mark_reviewed>");
    expect(joined).toContain("<redacted review URL action=decline>");
    expect(joined).toContain("<redacted review URL>");
  });
});

describe("getEmailTransport", () => {
  test("defaults to LogEmailTransport when MARGIN_EMAIL_TRANSPORT is unset", () => {
    const t = getEmailTransport();
    expect(t).toBeInstanceOf(LogEmailTransport);
  });

  test("returns ResendEmailTransport when MARGIN_EMAIL_TRANSPORT=resend and keys are set", () => {
    Bun.env.MARGIN_EMAIL_TRANSPORT = "resend";
    Bun.env.RESEND_API_KEY = "rk_test";
    Bun.env.MARGIN_EMAIL_FROM = "hi@example.com";
    const t = getEmailTransport();
    expect(t).toBeInstanceOf(ResendEmailTransport);
  });

  test("throws on invalid MARGIN_EMAIL_TRANSPORT value", () => {
    Bun.env.MARGIN_EMAIL_TRANSPORT = "smtp";
    expect(() => getEmailTransport()).toThrow(/invalid env var MARGIN_EMAIL_TRANSPORT/);
  });

  test("respects _setEmailTransportForTests override", () => {
    const stub: { send: (m: unknown) => Promise<void> } = {
      send: async () => {},
    };
    _setEmailTransportForTests(stub);
    expect(getEmailTransport()).toBe(stub);
  });
});
