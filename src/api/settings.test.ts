import { beforeEach, describe, expect, test } from "bun:test";
import { cleanDb, seedProject, seedUser } from "../../test/db.ts";
import { issueTestSession } from "../../test/session.ts";
import { postJsonRequest } from "../../test/fetch.ts";
import { handleSettingsPost } from "./settings.ts";

beforeEach(cleanDb);

const post = (body: unknown, opts?: { auth?: string }) =>
  postJsonRequest("/api/extension/settings", body, opts);

interface SettingsBody {
  settings: {
    notifyOnComment: boolean;
    notifyOnReviewComplete: boolean;
    defaultReviewerEmails: string[];
    slackWorkspaceRef: string | null;
    defaultOverlayId: string | null;
  };
}

describe("handleSettingsPost", () => {
  test("401 without bearer", async () => {
    const res = await handleSettingsPost(post({ projectId: "x" }));
    expect(res.status).toBe(401);
  });

  test("404 when caller isn't the owner", async () => {
    const owner = await seedUser();
    const proj = await seedProject({ ownerUserId: owner.id });
    const other = await seedUser({ email: "b@example.com" });
    const { token } = await issueTestSession({ userId: other.id });
    const res = await handleSettingsPost(
      post({ projectId: proj.id }, { auth: `Bearer ${token}` }),
    );
    expect(res.status).toBe(404);
  });

  test("returns defaults for a fresh project", async () => {
    const u = await seedUser();
    const proj = await seedProject({ ownerUserId: u.id });
    const { token } = await issueTestSession({ userId: u.id });
    const res = await handleSettingsPost(
      post({ projectId: proj.id }, { auth: `Bearer ${token}` }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as SettingsBody;
    expect(body.settings.notifyOnComment).toBe(true);
    expect(body.settings.defaultReviewerEmails).toEqual([]);
    expect(body.settings.slackWorkspaceRef).toBeNull();
  });

  test("patch updates the stored settings", async () => {
    const u = await seedUser();
    const proj = await seedProject({ ownerUserId: u.id });
    const { token } = await issueTestSession({ userId: u.id });
    const res = await handleSettingsPost(
      post(
        {
          projectId: proj.id,
          patch: {
            notifyOnComment: false,
            defaultReviewerEmails: ["a@example.com", "b@example.com"],
            slackWorkspaceRef: "T123",
          },
        },
        { auth: `Bearer ${token}` },
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as SettingsBody;
    expect(body.settings.notifyOnComment).toBe(false);
    expect(body.settings.defaultReviewerEmails).toEqual([
      "a@example.com",
      "b@example.com",
    ]);
    expect(body.settings.slackWorkspaceRef).toBe("T123");

    // Round-trip: a follow-up load returns the same values.
    const round = await handleSettingsPost(
      post({ projectId: proj.id }, { auth: `Bearer ${token}` }),
    );
    expect(round.status).toBe(200);
    const fresh = (await round.json()) as SettingsBody;
    expect(fresh.settings.notifyOnComment).toBe(false);
    expect(fresh.settings.slackWorkspaceRef).toBe("T123");
  });

  test("400 on malformed email entries", async () => {
    const u = await seedUser();
    const proj = await seedProject({ ownerUserId: u.id });
    const { token } = await issueTestSession({ userId: u.id });
    const res = await handleSettingsPost(
      post(
        {
          projectId: proj.id,
          patch: { defaultReviewerEmails: ["not-an-email"] },
        },
        { auth: `Bearer ${token}` },
      ),
    );
    expect(res.status).toBe(400);
  });
});
