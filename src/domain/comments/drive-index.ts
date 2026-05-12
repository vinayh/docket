import type {
  DriveComment,
  DriveCommentAuthor,
} from "../../google/drive.ts";
import { hashShort } from "./types.ts";

/**
 * For author identity disambiguation (SPEC §9.8). OOXML carries display name
 * only — two reviewers named "Sam Lee" are indistinguishable in `.docx`. The
 * Drive API exposes `me` (true on the authed user's own comments) and
 * `photoLink` (per-user URL). We hash the photoLink as a stable
 * disambiguator; `me === true` lets us recover email, which OOXML drops.
 */
export interface AuthorIdentity {
  email: string | null;
  photoHash: string | null;
}

export interface AuthorIndex {
  /** Display name → known identities. Many reviewers share names; we keep all. */
  byName: Map<string, AuthorIdentity[]>;
}

export function buildAuthorIndex(driveComments: DriveComment[]): AuthorIndex {
  const byName = new Map<string, AuthorIdentity[]>();
  const add = (a: DriveCommentAuthor | undefined) => {
    if (!a?.displayName) return;
    const identity: AuthorIdentity = {
      email: a.me ? (a.emailAddress ?? null) : null,
      photoHash: a.photoLink ? hashShort(a.photoLink) : null,
    };
    const list = byName.get(a.displayName) ?? [];
    // Avoid duplicating identical entries (one user commenting many times).
    if (!list.some((e) => e.email === identity.email && e.photoHash === identity.photoHash)) {
      list.push(identity);
    }
    byName.set(a.displayName, list);
  };
  for (const c of driveComments) {
    add(c.author);
    for (const r of c.replies ?? []) add(r.author);
  }
  return { byName };
}

export function resolveIdentity(
  index: AuthorIndex,
  displayName: string,
): AuthorIdentity {
  const candidates = index.byName.get(displayName);
  if (!candidates || candidates.length === 0) return { email: null, photoHash: null };
  // Unambiguous match: one identity for this display name. Multiple identities
  // means we cannot disambiguate from `.docx` alone — leave email null but
  // keep the photo hash if all candidates share it.
  if (candidates.length === 1) return candidates[0]!;
  const allSameHash = candidates.every((c) => c.photoHash === candidates[0]!.photoHash);
  return {
    email: null,
    photoHash: allSameHash ? candidates[0]!.photoHash : null,
  };
}

/**
 * For Drive-id recovery + reply chain reconstruction (SPEC §9.8 — "Parent-
 * reply linkage … reconstruct by same-anchor + w:date"). OOXML flattens
 * replies; the Drive API preserves the parent→reply tree. We match a
 * `DocxComment` to a Drive comment/reply by `(author display name, date)`,
 * truncated to second precision because OOXML drops sub-second.
 */
export interface DriveEntry {
  driveId: string;
  parentDriveId: string | null;
}

export interface DriveIndex {
  byAuthorAndDate: Map<string, DriveEntry>;
}

export function buildDriveIndex(driveComments: DriveComment[]): DriveIndex {
  const byAuthorAndDate = new Map<string, DriveEntry>();
  for (const c of driveComments) {
    if (c.deleted) continue;
    const key = driveLookupKey(c.author?.displayName, c.createdTime);
    if (key) byAuthorAndDate.set(key, { driveId: c.id, parentDriveId: null });
    for (const r of c.replies ?? []) {
      if (r.deleted) continue;
      const rkey = driveLookupKey(r.author?.displayName, r.createdTime);
      if (rkey) byAuthorAndDate.set(rkey, { driveId: r.id, parentDriveId: c.id });
    }
  }
  return { byAuthorAndDate };
}

export function driveLookupKey(
  displayName: string | undefined,
  createdTime: string | undefined,
): string | null {
  if (!displayName || !createdTime) return null;
  const ts = Date.parse(createdTime);
  if (Number.isNaN(ts)) return null;
  // Second precision — OOXML drops millis, Drive includes them.
  return `${displayName} ${Math.floor(ts / 1000)}`;
}
