import { afterEach, describe, expect, test } from "bun:test";
import { setFetch } from "../../test/fetch.ts";
import type { TokenProvider } from "./api.ts";
import {
  copyFile,
  createPermission,
  exportDocx,
  getFile,
  listComments,
  stopChannel,
  uploadFileMultipart,
  watchFile,
} from "./drive.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const tp: TokenProvider = {
  async getAccessToken() {
    return "access-test";
  },
  async refreshAccessToken() {
    return "access-test";
  },
};

interface CapturedRequest {
  url: string;
  method: string | undefined;
  contentType: string | null;
  body: string | Uint8Array | null;
}

function captureNext(response: Response | (() => Response)): {
  reqs: CapturedRequest[];
} {
  const reqs: CapturedRequest[] = [];
  setFetch(async (input, init) => {
    let body: string | Uint8Array | null = null;
    if (init?.body instanceof Uint8Array) body = init.body;
    else if (typeof init?.body === "string") body = init.body;
    reqs.push({
      url: String(input),
      method: init?.method,
      contentType: new Headers(init?.headers).get("content-type"),
      body,
    });
    return typeof response === "function" ? response() : response;
  });
  return { reqs };
}

describe("getFile", () => {
  test("hits /drive/v3/files/<id> with the default field set + supportsAllDrives", async () => {
    const { reqs } = captureNext(
      new Response(JSON.stringify({ id: "abc", name: "X", mimeType: "m" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const f = await getFile(tp, "abc-id/with/slash");
    expect(f.id).toBe("abc");
    expect(reqs).toHaveLength(1);
    const u = new URL(reqs[0]!.url);
    expect(u.pathname).toBe("/drive/v3/files/abc-id%2Fwith%2Fslash");
    expect(u.searchParams.get("fields")).toBe(
      "id,name,mimeType,modifiedTime,createdTime,parents,webViewLink,trashed",
    );
    expect(u.searchParams.get("supportsAllDrives")).toBe("true");
  });

  test("respects a caller-supplied fields override", async () => {
    const { reqs } = captureNext(
      new Response(JSON.stringify({ id: "x", name: "y", mimeType: "m" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await getFile(tp, "x", { fields: "id,name" });
    expect(new URL(reqs[0]!.url).searchParams.get("fields")).toBe("id,name");
  });
});

describe("exportDocx", () => {
  test("requests the wordprocessingml mimeType and returns the raw bytes", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const { reqs } = captureNext(
      new Response(bytes, {
        status: 200,
        headers: {
          "content-type":
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        },
      }),
    );
    const out = await exportDocx(tp, "doc-xyz");
    expect(out).toEqual(bytes);
    const u = new URL(reqs[0]!.url);
    expect(u.pathname).toBe("/drive/v3/files/doc-xyz/export");
    expect(u.searchParams.get("mimeType")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
  });

  test("throws with status + body on a non-OK", async () => {
    captureNext(new Response("server says no", { status: 503 }));
    await expect(exportDocx(tp, "x")).rejects.toThrow(
      /exportDocx failed: 503 server says no/,
    );
  });
});

describe("copyFile", () => {
  test("POSTs with JSON body and supportsAllDrives + DEFAULT_FILE_FIELDS", async () => {
    const { reqs } = captureNext(
      new Response(JSON.stringify({ id: "new", name: "n", mimeType: "m" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const copy = await copyFile(tp, "src-id", { name: "Copy of X" });
    expect(copy.id).toBe("new");
    const u = new URL(reqs[0]!.url);
    expect(u.pathname).toBe("/drive/v3/files/src-id/copy");
    expect(u.searchParams.get("supportsAllDrives")).toBe("true");
    expect(reqs[0]!.method).toBe("POST");
    expect(reqs[0]!.contentType).toBe("application/json");
    expect(JSON.parse(reqs[0]!.body as string)).toEqual({ name: "Copy of X" });
  });
});

describe("watchFile", () => {
  test("POSTs the channel envelope to /files/<id>/watch and surfaces the resourceId", async () => {
    const { reqs } = captureNext(
      new Response(
        JSON.stringify({
          kind: "api#channel",
          id: "ch-1",
          resourceId: "res-1",
          resourceUri: "u",
          expiration: "1234567890",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    const channel = await watchFile(tp, "doc-1", {
      channelId: "ch-1",
      address: "https://example.com/webhooks/drive",
      token: "secret",
      expirationMs: 9999,
    });
    expect(channel.id).toBe("ch-1");
    expect(channel.resourceId).toBe("res-1");
    expect(reqs[0]!.url).toContain("/drive/v3/files/doc-1/watch");
    expect(reqs[0]!.method).toBe("POST");
    const body = JSON.parse(reqs[0]!.body as string);
    expect(body).toEqual({
      id: "ch-1",
      type: "web_hook",
      address: "https://example.com/webhooks/drive",
      token: "secret",
      expiration: "9999",
    });
  });
});

describe("stopChannel", () => {
  test("POSTs to /drive/v3/channels/stop with id + resourceId", async () => {
    const { reqs } = captureNext(new Response(null, { status: 204 }));
    await stopChannel(tp, { id: "ch-1", resourceId: "res-1" });
    expect(reqs[0]!.url).toMatch(/\/drive\/v3\/channels\/stop$/);
    expect(reqs[0]!.method).toBe("POST");
    expect(JSON.parse(reqs[0]!.body as string)).toEqual({
      id: "ch-1",
      resourceId: "res-1",
    });
  });

  test("treats 404 from the stop endpoint as success (idempotent)", async () => {
    captureNext(new Response("already gone", { status: 404 }));
    await expect(
      stopChannel(tp, { id: "ch-1", resourceId: "res-1" }),
    ).resolves.toBeUndefined();
  });

  test("throws on a non-404 failure", async () => {
    captureNext(new Response("boom", { status: 500 }));
    await expect(
      stopChannel(tp, { id: "ch-1", resourceId: "res-1" }),
    ).rejects.toThrow(/stopChannel failed: 500/);
  });
});

describe("createPermission", () => {
  test("POSTs a user/commenter permission with sendNotificationEmail=false by default", async () => {
    const { reqs } = captureNext(
      new Response(
        JSON.stringify({ id: "perm-1", type: "user", role: "commenter" }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    await createPermission(tp, "doc-1", { emailAddress: "x@y.com" });
    const u = new URL(reqs[0]!.url);
    expect(u.pathname).toBe("/drive/v3/files/doc-1/permissions");
    expect(u.searchParams.get("sendNotificationEmail")).toBe("false");
    expect(u.searchParams.get("supportsAllDrives")).toBe("true");
    expect(JSON.parse(reqs[0]!.body as string)).toEqual({
      type: "user",
      role: "commenter",
      emailAddress: "x@y.com",
    });
  });

  test("honors the role override and sendNotificationEmail=true", async () => {
    const { reqs } = captureNext(
      new Response(
        JSON.stringify({ id: "perm-2", type: "user", role: "reader" }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    await createPermission(tp, "doc-2", {
      emailAddress: "r@y.com",
      role: "reader",
      sendNotificationEmail: true,
    });
    expect(new URL(reqs[0]!.url).searchParams.get("sendNotificationEmail")).toBe(
      "true",
    );
    expect(JSON.parse(reqs[0]!.body as string).role).toBe("reader");
  });
});

describe("listComments", () => {
  test("paginates: follows nextPageToken until exhausted, concatenating comments", async () => {
    const pages = [
      { comments: [{ id: "c1" }, { id: "c2" }], nextPageToken: "tok-2" },
      { comments: [{ id: "c3" }], nextPageToken: undefined },
    ];
    const calls: URL[] = [];
    setFetch(async (input) => {
      const u = new URL(String(input));
      calls.push(u);
      const page = pages.shift()!;
      return new Response(JSON.stringify(page), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const all = await listComments(tp, "doc-id");
    expect(all.map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.searchParams.get("pageToken")).toBeNull();
    expect(calls[1]!.searchParams.get("pageToken")).toBe("tok-2");
    expect(calls[0]!.searchParams.get("pageSize")).toBe("100");
  });

  test("passes through includeDeleted + startModifiedTime", async () => {
    const { reqs } = captureNext(
      new Response(JSON.stringify({ comments: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await listComments(tp, "doc-id", {
      includeDeleted: true,
      startModifiedTime: "2026-01-01T00:00:00Z",
    });
    const u = new URL(reqs[0]!.url);
    expect(u.searchParams.get("includeDeleted")).toBe("true");
    expect(u.searchParams.get("startModifiedTime")).toBe("2026-01-01T00:00:00Z");
  });
});

describe("uploadFileMultipart", () => {
  test("frames metadata + bytes as multipart/related with a margin-* boundary", async () => {
    const { reqs } = captureNext(
      new Response(
        JSON.stringify({ id: "u-1", name: "test.docx", mimeType: "m" }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const payload = new Uint8Array([0x50, 0x4b, 0x03, 0x04]); // "PK\x03\x04" — zip magic
    await uploadFileMultipart(tp, {
      name: "test.docx",
      bytes: payload,
      sourceMimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      targetMimeType: "application/vnd.google-apps.document",
    });
    expect(reqs[0]!.method).toBe("POST");
    const ct = reqs[0]!.contentType!;
    const m = /multipart\/related; boundary=(margin-[^\s;]+)/.exec(ct);
    expect(m).not.toBeNull();
    const boundary = m![1]!;
    const body = reqs[0]!.body as Uint8Array;
    expect(body).toBeInstanceOf(Uint8Array);
    const text = new TextDecoder().decode(body);
    // metadata + body + trailing boundary all present, in that order.
    expect(text.startsWith(`--${boundary}\r\n`)).toBe(true);
    expect(text.endsWith(`\r\n--${boundary}--`)).toBe(true);
    expect(text).toContain('"name":"test.docx"');
    expect(text).toContain(
      '"mimeType":"application/vnd.google-apps.document"',
    );
    expect(text).toContain(
      "Content-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    // Raw bytes preserved verbatim — find the zip magic in the body.
    expect(body.indexOf(0x50)).toBeGreaterThan(0);
  });

  test("omits mimeType from metadata when no targetMimeType is given", async () => {
    const { reqs } = captureNext(
      new Response(JSON.stringify({ id: "u", name: "n", mimeType: "m" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await uploadFileMultipart(tp, {
      name: "n",
      bytes: new Uint8Array([]),
      sourceMimeType: "application/octet-stream",
    });
    const text = new TextDecoder().decode(reqs[0]!.body as Uint8Array);
    expect(text).toContain('"name":"n"');
    expect(text).not.toContain('"mimeType":');
  });
});
