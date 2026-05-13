import { describe, expect, test } from "bun:test";
import type { DriveComment } from "../../google/drive.ts";
import {
  buildAuthorIndex,
  buildDriveIndex,
  driveLookupKey,
  resolveIdentity,
} from "./drive-index.ts";
import { hashShort } from "./types.ts";

function driveComment(opts: {
  id: string;
  displayName: string;
  email?: string;
  me?: boolean;
  photoLink?: string;
  createdTime: string;
  replies?: DriveComment["replies"];
  deleted?: boolean;
}): DriveComment {
  return {
    id: opts.id,
    author: {
      displayName: opts.displayName,
      emailAddress: opts.email,
      me: opts.me,
      photoLink: opts.photoLink,
    },
    createdTime: opts.createdTime,
    content: "",
    replies: opts.replies,
    deleted: opts.deleted,
  };
}

describe("resolveIdentity", () => {
  test("unknown display name → email + photoHash both null", () => {
    const index = buildAuthorIndex([]);
    expect(resolveIdentity(index, "Nobody")).toEqual({
      email: null,
      photoHash: null,
    });
  });

  test("single candidate → returns that identity (email + photoHash)", () => {
    const index = buildAuthorIndex([
      driveComment({
        id: "1",
        displayName: "Alice",
        email: "alice@example.com",
        me: true,
        photoLink: "https://lh3/alice.jpg",
        createdTime: "2026-01-01T00:00:00Z",
      }),
    ]);
    const got = resolveIdentity(index, "Alice");
    expect(got.email).toBe("alice@example.com");
    expect(got.photoHash).toBe(hashShort("https://lh3/alice.jpg"));
  });

  test("multiple candidates with the SAME photoHash collapse to one identity (same person, no email)", () => {
    // Two comments by the same person — one with `me:true` (email recorded),
    // one without. buildAuthorIndex dedupes identical identities, so when the
    // .me flag flips the index records TWO entries: { email, photoHash } and
    // { email:null, photoHash }. resolveIdentity sees length>1 with matching
    // hashes and returns null email + the shared photoHash.
    const photoLink = "https://lh3/sam.jpg";
    const index = buildAuthorIndex([
      driveComment({
        id: "1",
        displayName: "Sam",
        email: "sam@example.com",
        me: true,
        photoLink,
        createdTime: "2026-01-01T00:00:00Z",
      }),
      driveComment({
        id: "2",
        displayName: "Sam",
        me: false, // me=false → email is dropped, identity = { null, hash }
        photoLink,
        createdTime: "2026-01-02T00:00:00Z",
      }),
    ]);
    const got = resolveIdentity(index, "Sam");
    expect(got.email).toBeNull();
    expect(got.photoHash).toBe(hashShort(photoLink));
  });

  test("multiple candidates with DIFFERENT photoHash → both email + photoHash null (truly ambiguous)", () => {
    const index = buildAuthorIndex([
      driveComment({
        id: "1",
        displayName: "Sam",
        photoLink: "https://lh3/sam-a.jpg",
        createdTime: "2026-01-01T00:00:00Z",
      }),
      driveComment({
        id: "2",
        displayName: "Sam",
        photoLink: "https://lh3/sam-b.jpg",
        createdTime: "2026-01-02T00:00:00Z",
      }),
    ]);
    const got = resolveIdentity(index, "Sam");
    expect(got.email).toBeNull();
    expect(got.photoHash).toBeNull();
  });
});

describe("buildDriveIndex / driveLookupKey", () => {
  test("driveLookupKey is null when displayName or createdTime is missing", () => {
    expect(driveLookupKey(undefined, "2026-01-01T00:00:00Z")).toBeNull();
    expect(driveLookupKey("Alice", undefined)).toBeNull();
    expect(driveLookupKey("Alice", "not-a-date")).toBeNull();
  });

  test("driveLookupKey truncates to second precision (OOXML drops millis)", () => {
    const a = driveLookupKey("Alice", "2026-01-01T00:00:00.000Z");
    const b = driveLookupKey("Alice", "2026-01-01T00:00:00.999Z");
    expect(a).toBe(b);
  });

  test("buildDriveIndex links replies to parent driveId via author+date key", () => {
    const index = buildDriveIndex([
      driveComment({
        id: "parent-1",
        displayName: "Parent",
        createdTime: "2026-01-01T10:00:00Z",
        replies: [
          {
            id: "reply-1",
            author: { displayName: "Replier" },
            createdTime: "2026-01-01T11:00:00Z",
            content: "",
          },
        ],
      }),
    ]);
    const parent = index.byAuthorAndDate.get(
      driveLookupKey("Parent", "2026-01-01T10:00:00Z")!,
    );
    const reply = index.byAuthorAndDate.get(
      driveLookupKey("Replier", "2026-01-01T11:00:00Z")!,
    );
    expect(parent?.driveId).toBe("parent-1");
    expect(parent?.parentDriveId).toBeNull();
    expect(reply?.driveId).toBe("reply-1");
    expect(reply?.parentDriveId).toBe("parent-1");
  });

  test("buildDriveIndex skips deleted comments and replies", () => {
    const index = buildDriveIndex([
      driveComment({
        id: "deleted-parent",
        displayName: "Parent",
        createdTime: "2026-01-01T10:00:00Z",
        deleted: true,
      }),
      driveComment({
        id: "live-parent",
        displayName: "Live",
        createdTime: "2026-01-01T11:00:00Z",
        replies: [
          {
            id: "deleted-reply",
            author: { displayName: "DeletedReply" },
            createdTime: "2026-01-01T12:00:00Z",
            content: "",
            deleted: true,
          },
        ],
      }),
    ]);
    expect(
      index.byAuthorAndDate.has(driveLookupKey("Parent", "2026-01-01T10:00:00Z")!),
    ).toBe(false);
    expect(
      index.byAuthorAndDate.has(driveLookupKey("Live", "2026-01-01T11:00:00Z")!),
    ).toBe(true);
    expect(
      index.byAuthorAndDate.has(
        driveLookupKey("DeletedReply", "2026-01-01T12:00:00Z")!,
      ),
    ).toBe(false);
  });
});
