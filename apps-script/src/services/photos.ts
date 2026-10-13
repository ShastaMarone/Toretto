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

/** Pictures by email from the deployer's own contacts (including "Other contacts": people they've emailed). */
export type ContactPhotos = Map<string, string>;

/**
 * Many organizations turn off directory sharing, so the app also looks in the
 * Google contacts of the account that runs it, which the app has emailed. Reads
 * both lists; throws only if neither could be read.
 */
export function readContactPhotos(): ContactPhotos {
  const index: ContactPhotos = new Map();
  const add = (people: DirectoryPerson[] | undefined) => {
    for (const p of people ?? []) {
      const url = photoOf(p);
      if (!url) continue;
      for (const e of p.emailAddresses ?? []) {
        const key = (e.value ?? '').toLowerCase();
        if (key && !index.has(key)) index.set(key, url);
      }
    }
  };
  const errors: string[] = [];
  const attempt = (read: () => void) => {
    try {
      read();
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  };
  attempt(() => {
    let pageToken: string | undefined;
    do {
      const page = People!.OtherContacts!.list({
        readMask: 'photos,emailAddresses',
        pageSize: 1000,
        pageToken,
      });
      add(page.otherContacts);
      pageToken = page.nextPageToken;
    } while (pageToken);
  });
  attempt(() => {
    let pageToken: string | undefined;
    do {
      const page = People!.People!.Connections!.list('people/me', {
        personFields: 'photos,emailAddresses',
        pageSize: 1000,
        pageToken,
      });
      add(page.connections);
      pageToken = page.nextPageToken;
    } while (pageToken);
  });
  if (errors.length === 2) throw new Error(errors.join(' | '));
  return index;
}

/** Their picture from the Google directory, or null. Throws if the directory can't be read. */
function directoryPhoto(email: string): string | null {
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

/**
 * Their picture, or null when they haven't set one: from the company directory
 * when it's shared, otherwise from the app account's contacts (`contacts` reads
 * them once for a whole batch). Throws when no source could be read: callers
 * keep what they have.
 */
export function lookupPhoto(email: string, contacts: () => ContactPhotos): string | null {
  let directoryError: unknown = null;
  try {
    const url = directoryPhoto(email);
    if (url) return url;
  } catch (err) {
    directoryError = err;
  }
  try {
    return contacts().get(email.toLowerCase()) ?? null;
  } catch (err) {
    throw directoryError ?? err;
  }
}

/** Reads the contacts at most once: for a batch of lookups. */
export function lazyContacts(): () => ContactPhotos {
  let index: ContactPhotos | null = null;
  return () => (index ??= readContactPhotos());
}

const isStale = (u: UserRow, now: string) =>
  !u.photoCheckedAt || ms(now) - ms(u.photoCheckedAt) > RECHECK_DAYS * 86_400_000;

/** Fetch and store one person's picture. A failed lookup is left to try again next time. */
export function refreshPhoto(db: Db, u: UserRow, contacts = lazyContacts()): UserRow {
  try {
    const photoUrl = lookupPhoto(u.email, contacts);
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
  const never = '1970-01-01T00:00:00Z';
  const due = t.users
    .where((u) => !u.deactivatedAt && isStale(u, ctx.now))
    .sort((a, b) => ms(a.photoCheckedAt ?? never) - ms(b.photoCheckedAt ?? never))
    .slice(0, BATCH);
  const contacts = lazyContacts();
  let done = 0;
  for (const u of due) {
    const after = refreshPhoto(ctx.db, u, contacts);
    if (after === u) break;
    done++;
  }
  return done;
}

/** Run from the editor: what each Google source says about the first few people. */
export function diagnosePhotos(db: Db): string {
  const lines: string[] = [];
  const tryRead = <T>(label: string, read: () => T): T | null => {
    try {
      return read();
    } catch (err) {
      lines.push(`${label}: ERROR ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  };
  const other = tryRead('Other contacts', () =>
    People!.OtherContacts!.list({ readMask: 'photos,emailAddresses', pageSize: 1000 }),
  );
  if (other) {
    const list = other.otherContacts ?? [];
    lines.push(
      `Other contacts: ${list.length} people (first page), ${list.filter((p) => photoOf(p)).length} with a picture`,
    );
  }
  const mine = tryRead('My contacts', () =>
    People!.People!.Connections!.list('people/me', {
      personFields: 'photos,emailAddresses',
      pageSize: 1000,
    }),
  );
  if (mine) {
    const list = mine.connections ?? [];
    lines.push(
      `My contacts: ${list.length} people (first page), ${list.filter((p) => photoOf(p)).length} with a picture`,
    );
  }
  const index = tryRead('Combined', readContactPhotos);
  for (const u of tables(db).users.all().slice(0, 8)) {
    lines.push(
      `${u.email}: stored=${u.photoUrl ?? 'none'} checked=${u.photoCheckedAt ?? 'never'} contacts=${index?.get(u.email.toLowerCase()) ?? 'no picture'}`,
    );
  }
  const out = lines.join('\n');
  console.log(out);
  return out;
}
