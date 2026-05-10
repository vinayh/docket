import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { handlePickerConfig } from "./picker-config.ts";

/**
 * `handlePickerConfig` reads `Bun.env` lazily through `config.google.*`,
 * so each test snapshots and restores the three env vars it touches.
 * `GOOGLE_CLIENT_ID` is `required()` and throws when unset; the route
 * catches that so a partial deployment still serves a usable
 * "not configured" payload instead of 500-ing the whole popup load.
 */
const KEYS = ["GOOGLE_CLIENT_ID", "GOOGLE_API_KEY", "GOOGLE_PROJECT_NUMBER"] as const;

const original: Record<(typeof KEYS)[number], string | undefined> = {
  GOOGLE_CLIENT_ID: undefined,
  GOOGLE_API_KEY: undefined,
  GOOGLE_PROJECT_NUMBER: undefined,
};

beforeEach(() => {
  for (const k of KEYS) {
    original[k] = Bun.env[k];
    delete Bun.env[k];
  }
});

afterEach(() => {
  for (const k of KEYS) {
    if (original[k] === undefined) delete Bun.env[k];
    else Bun.env[k] = original[k]!;
  }
});

describe("handlePickerConfig", () => {
  test("returns 200 with all-null fields when nothing is configured", async () => {
    const res = handlePickerConfig(new Request("http://localhost/api/picker/config"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      clientId: string | null;
      apiKey: string | null;
      projectNumber: string | null;
    };
    expect(body).toEqual({ clientId: null, apiKey: null, projectNumber: null });
  });

  test("returns 200 with populated fields when all three are set", async () => {
    Bun.env.GOOGLE_CLIENT_ID = "client-123";
    Bun.env.GOOGLE_API_KEY = "api-456";
    Bun.env.GOOGLE_PROJECT_NUMBER = "project-789";

    const res = handlePickerConfig(new Request("http://localhost/api/picker/config"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      clientId: string | null;
      apiKey: string | null;
      projectNumber: string | null;
    };
    expect(body).toEqual({
      clientId: "client-123",
      apiKey: "api-456",
      projectNumber: "project-789",
    });
  });

  test("returns clientId:null instead of 500 when GOOGLE_CLIENT_ID is unset but the others are populated", async () => {
    // No GOOGLE_CLIENT_ID — `config.google.clientId` would normally throw.
    Bun.env.GOOGLE_API_KEY = "api-456";
    Bun.env.GOOGLE_PROJECT_NUMBER = "project-789";

    const res = handlePickerConfig(new Request("http://localhost/api/picker/config"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      clientId: string | null;
      apiKey: string | null;
      projectNumber: string | null;
    };
    expect(body.clientId).toBeNull();
    expect(body.apiKey).toBe("api-456");
    expect(body.projectNumber).toBe("project-789");
  });
});
