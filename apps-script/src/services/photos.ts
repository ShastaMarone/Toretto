import { ms, tables, type Ctx } from '../core';
import type { Db } from '../db/store';
import type { UserRow } from '../db/schema';

/** Look again for a picture this often (people change them rarely). */
const RECHECK_DAYS = 7;
/** Directory lookups per hourly run, so a big team can't use up the run. */
const BATCH = 25;
const AVATAR_PX = 96;

type DirectoryPerson = {
  emailAddresses?: { value?: string | null }[];
  photos?: { url?: string | null; default?: boolean | null }[];
};

/**
 * Google serves one picture at any size: a URL ending in "=s100" (or "=s100-c")
 * sets the size. Ask for a small, square crop; leave other shapes of URL alone.
 */
export function sizedPhotoUrl(url: string): string {
  return /=s\d+(-c)?$/.test(url) ? url.replace(/=s\d+(-c)?$/, `=s${AVATAR_PX}-c`) : url;
}

/** The picture they chose (not Google's grey default silhouette), or null. */
export function photoOf(person: DirectoryPerson | undefined): string | null {
  const photo = person?.photos?.find((p) => p.url && !p.default);
  return photo?.url ? sizedPhotoUrl(photo.url) : null;
}

/**
 * Their picture from the company's Google directory (the People API), or null
 * when they haven't set one. Throws if the directory can't be read (it isn't
 * shared, or the permission wasn't allowed): callers keep what they have.
 */
export function lookupPhoto(email: string): string | null {
  const found = People!.People!.searchDirectoryPeople({
    query: email,
    readMask: 'photos,emailAddresses',
    sources: ['DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE'],
    pageSize: 5,
  });
  const person = (found.people ?? []).find((p) =>
    (p.emailAddresses ?? []).some((e) => (e.value ?? '').toLowerCase() === email.toLowerCase()),
  );
  return photoOf(person);
}

const isStale = (u: UserRow, now: string) =>
  !u.photoCheckedAt || ms(now) - ms(u.photoCheckedAt) > RECHECK_DAYS * 86_400_000;

/** Fetch and store one person's picture. A failed lookup is left to try again next time. */
export function refreshPhoto(db: Db, u: UserRow): UserRow {
  try {
    const photoUrl = lookupPhoto(u.email);
    return tables(db).users.update(u.id, { photoUrl, photoCheckedAt: db.now });
  } catch (err) {
    console.error(`Profile pictures: ${err instanceof Error ? err.message : String(err)}`);
    return u;
  }
}

/**
 * Hourly: look up pictures for people we haven't checked (or not for a week).
 * Stops at the first failure, since the rest would fail the same way.
 */
export function syncPhotos(ctx: Ctx): number {
  const t = tables(ctx.db);
  const due = t.users
    .where((u) => !u.deactivatedAt && isStale(u, ctx.now))
    .sort((a, b) => ms(a.photoCheckedAt ?? '1970-01-01T00:00:00Z') - ms(b.photoCheckedAt ?? '1970-01-01T00:00:00Z'))
    .slice(0, BATCH);
  let done = 0;
  for (const u of due) {
    const after = refreshPhoto(ctx.db, u);
    if (after === u) break;
    done++;
  }
  return done;
}

/** Run from the editor: what the directory says about the first few people, and what's stored. */
export function diagnosePhotos(db: Db): string {
  const lines: string[] = [];
  for (const u of tables(db).users.all().slice(0, 5)) {
    let said: string;
    try {
      const found = People!.People!.searchDirectoryPeople({
        query: u.email,
        readMask: 'photos,emailAddresses',
        sources: ['DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE'],
        pageSize: 5,
      });
      said = `directory returned ${JSON.stringify(found).slice(0, 400)}`;
    } catch (err) {
      said = `directory ERROR: ${err instanceof Error ? err.message : String(err)}`;
    }
    lines.push(`${u.email}: stored=${u.photoUrl ?? 'none'} checked=${u.photoCheckedAt ?? 'never'}; ${said}`);
  }
  const out = lines.join('\n');
  console.log(out);
  return out;
}
