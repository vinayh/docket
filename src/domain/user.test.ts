import { beforeEach, describe, expect, test } from "bun:test";
import { cleanDb, seedUser } from "../../test/db.ts";
import {
  firstUser,
  getUserByEmail,
  requireFirstUser,
  requireUserByEmail,
  resolveUserByEmailOrFirst,
  userIdByEmail,
} from "./user.ts";

beforeEach(cleanDb);

describe("getUserByEmail / userIdByEmail", () => {
  test("returns null when no user exists for the email", async () => {
    expect(await getUserByEmail("nobody@example.com")).toBeNull();
    expect(await userIdByEmail("nobody@example.com")).toBeNull();
  });

  test("returns the matching user row", async () => {
    const u = await seedUser({ email: "alice@example.com" });
    const found = await getUserByEmail("alice@example.com");
    expect(found?.id).toBe(u.id);
    expect(await userIdByEmail("alice@example.com")).toBe(u.id);
  });

  test("userIdByEmail short-circuits on null/undefined/empty", async () => {
    expect(await userIdByEmail(null)).toBeNull();
    expect(await userIdByEmail(undefined)).toBeNull();
    expect(await userIdByEmail("")).toBeNull();
  });
});

describe("requireUserByEmail", () => {
  test("returns the row when present", async () => {
    const u = await seedUser({ email: "bob@example.com" });
    const got = await requireUserByEmail("bob@example.com");
    expect(got.id).toBe(u.id);
  });

  test("throws with the offending email when absent", async () => {
    await expect(requireUserByEmail("ghost@example.com")).rejects.toThrow(
      /ghost@example\.com/,
    );
  });
});

describe("firstUser / requireFirstUser", () => {
  test("firstUser returns null for an empty DB", async () => {
    expect(await firstUser()).toBeNull();
  });

  test("requireFirstUser throws a CLI-friendly hint when no user exists", async () => {
    await expect(requireFirstUser()).rejects.toThrow(/connect/);
  });

  test("returns a user row when one exists", async () => {
    const u = await seedUser();
    const got = await requireFirstUser();
    expect(got.id).toBe(u.id);
  });
});

describe("resolveUserByEmailOrFirst", () => {
  test("with email → looks up by email", async () => {
    await seedUser({ email: "primary@example.com" });
    const target = await seedUser({ email: "target@example.com" });
    const got = await resolveUserByEmailOrFirst("target@example.com");
    expect(got.id).toBe(target.id);
  });

  test("without email → falls back to first user", async () => {
    const first = await seedUser({ email: "primary@example.com" });
    await seedUser({ email: "second@example.com" });
    const got = await resolveUserByEmailOrFirst();
    expect(got.id).toBe(first.id);
  });
});
