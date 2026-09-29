// Google Calendar. Everyone who turns it on gets their confirmed shifts and
// approved time off as invitations from one calendar the app keeps, in the
// Google account that set the app up ("<organization> shifts"). Once a shift
// is on someone's calendar it follows changes until it's over; cancelled or
// reassigned shifts come off, and so does everything upcoming when they turn
// it off. Past events are left alone.
//
// It runs in the background (sendQueuedEmails, right after changes and every
// 5 minutes): work out what should be on calendars, change what isn't, and
// keep track in the calendar_events tab, one row per shift or time off.
import { addDays, dayRangeToUtc, localDate } from '@shared/time';
import { getSettings, iso, ms, tables } from '../core';
import type { CalendarEventRow } from '../db/schema';
import { Db } from '../db/store';
import { appUrl } from '../env';

/** The app's calendar (a script property). */
export const CALENDAR_ID = 'CALENDAR_ID';
/** Until when a run is busy changing calendars, so runs don't do the same work twice. */
export const LEASE = 'CALENDAR_SYNC_LEASE';
/** Longer than a run can last (Apps Script stops them at 6 minutes). */
const LEASE_MS = 7 * 60_000;
/** After failing to reach Google Calendar at all, wait this long. */
const PAUSE_MS = 5 * 60_000;
/** Calendar changes per run: Google slows down scripts that make many at once. */
export const BATCH = 50;
/** Minutes to wait after failure n (then every 6 hours, in case access comes back). */
const BACKOFF_MINUTES = [1, 5, 15, 60];
const DAYS_AHEAD = 366;
/** Rows for events that ended this long ago are dropped (the events stay). */
export const KEEP_DAYS = 30;
const DAY_MS = 86_400_000;

type When = { start: string; end: string } | { firstDay: string; lastDay: string };

interface Wanted {
  key: string;
  userId: string;
  email: string;
  title: string;
  description: string;
  when: When;
  endsAt: string;
  signature: string;
}

export type Op =
  | { kind: 'create'; want: Wanted; row?: CalendarEventRow }
  | { kind: 'update'; want: Wanted; row: CalendarEventRow }
  | { kind: 'replace'; want: Wanted; row: CalendarEventRow }
  | { kind: 'delete'; row: CalendarEventRow }
  | { kind: 'forget'; row: CalendarEventRow };

interface Result {
  op: Op;
  eventId?: string | null;
  error?: string;
}

/** A short fingerprint of what an event says. */
function hash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = (Math.imul(h, 33) + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

/** What should be on people's calendars now, by key. */
export function wantedEvents(db: Db, now: string): Map<string, Wanted> {
  const t = tables(db);
  const wanted = new Map<string, Wanted>();
  const people = new Map(
    t.users.where((u) => u.calendarSync && !u.deactivatedAt).map((u) => [u.id, u]),
  );
  if (!people.size) return wanted;
  const { timezone } = getSettings(db);
  const onCalendar = new Set(t.calendarEvents.all().map((r) => `${r.key} ${r.userId}`));
  const open = `Open the schedule: ${appUrl()}/my-schedule`;
  const manySchedules = t.schedules.all().length > 1;
  const add = (w: Omit<Wanted, 'email' | 'signature'>) => {
    const email = people.get(w.userId)!.email;
    const signature = hash(JSON.stringify([email, w.title, w.description, w.when]));
    wanted.set(w.key, { ...w, email, signature });
  };

  const until = ms(now) + DAYS_AHEAD * DAY_MS;
  for (const s of t.shifts.all()) {
    if (!s.publishedAt || !s.publishedUserId || !people.has(s.publishedUserId)) continue;
    const start = s.publishedStartTime!;
    const end = s.publishedEndTime!;
    if (ms(end) <= ms(now) || ms(start) > until) continue;
    const key = `shift:${s.id}`;
    const confirmed = s.status === 'confirmed';
    // It goes on once they confirm it, then stays on through changes.
    if (!confirmed && !onCalendar.has(`${key} ${s.publishedUserId}`)) continue;
    const label = t.labels.get(s.publishedLabelId);
    const schedule = t.schedules.get(s.scheduleId);
    add({
      key,
      userId: s.publishedUserId,
      title: label ? `${label.name} shift` : 'Shift',
      description: [
        !confirmed && 'This shift changed. Please confirm it in the app.',
        manySchedules && schedule && `Schedule: ${schedule.name}`,
        s.publishedNotes && `Notes: ${s.publishedNotes}`,
        open,
      ]
        .filter(Boolean)
        .join('\n'),
      when: { start, end },
      endsAt: end,
    });
  }

  const today = localDate(now, timezone);
  const lastDay = addDays(today, DAYS_AHEAD);
  for (const r of t.timeOff.all()) {
    if (r.status !== 'approved' || !people.has(r.userId)) continue;
    if (r.endDate < today || r.startDate > lastDay) continue;
    const partial = r.startTime !== null && r.endTime !== null;
    const endsAt = partial ? r.endTime! : dayRangeToUtc(r.startDate, r.endDate, timezone).to;
    if (ms(endsAt) <= ms(now)) continue;
    add({
      key: `time-off:${r.id}`,
      userId: r.userId,
      title: `Time off: ${t.timeOffTypes.get(r.typeId)?.name ?? 'Time off'}`,
      description: [r.note && `Note: ${r.note}`, open].filter(Boolean).join('\n'),
      when: partial
        ? { start: r.startTime!, end: r.endTime! }
        : { firstDay: r.startDate, lastDay: r.endDate },
      endsAt,
    });
  }
  return wanted;
}

/** The calendar changes to make next, at most BATCH, removals first. */
export function planCalendarSync(db: Db, now: string): Op[] {
  const wanted = wantedEvents(db, now);
  const rows = tables(db).calendarEvents.all();
  const due = (r: CalendarEventRow) => !r.retryAfter || ms(r.retryAfter) <= ms(now);
  const ops: Op[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    seen.add(row.key);
    const want = wanted.get(row.key);
    if (!want) {
      // Over: leave it on their calendar. Otherwise it was cancelled,
      // reassigned, or they turned the calendar off.
      if (ms(row.endsAt) <= ms(now)) continue;
      if (!row.eventId) ops.push({ kind: 'forget', row });
      else if (due(row)) ops.push({ kind: 'delete', row });
    } else if (!row.eventId) {
      if (due(row)) ops.push({ kind: 'create', want, row });
    } else if (row.userId !== want.userId || row.email !== want.email) {
      if (due(row)) ops.push({ kind: 'replace', want, row });
    } else if (row.signature !== want.signature && due(row)) {
      ops.push({ kind: 'update', want, row });
    }
  }
  for (const want of wanted.values()) {
    if (!seen.has(want.key)) ops.push({ kind: 'create', want });
  }
  const order = { forget: 0, delete: 1, replace: 2, update: 3, create: 4 };
  return ops.sort((a, b) => order[a.kind] - order[b.kind]).slice(0, BATCH);
}

/** The app's calendar, made on first use (or again, if it was deleted). */
function appCalendar(orgName: string): {
  calendar: GoogleAppsScript.Calendar.Calendar;
  isNew: boolean;
} {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty(CALENDAR_ID);
  const existing = id ? CalendarApp.getCalendarById(id) : null;
  if (existing) return { calendar: existing, isNew: false };
  const calendar = CalendarApp.createCalendar(`${orgName} shifts`, {
    summary:
      'Shifts and time off from the scheduling app. Everyone is invited to their own. ' +
      'Change them in the app: changes made here are overwritten.',
  });
  props.setProperty(CALENDAR_ID, calendar.getId());
  return { calendar, isNew: true };
}

/** 'YYYY-MM-DD' as a date in the script's time zone, for all-day events. */
function day(date: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y!, m! - 1, d!);
}

function run(calendar: GoogleAppsScript.Calendar.Calendar, op: Op): Result {
  const create = (want: Wanted) => {
    const options = { description: want.description, guests: want.email, sendInvites: false };
    const event =
      'start' in want.when
        ? calendar.createEvent(
            want.title,
            new Date(want.when.start),
            new Date(want.when.end),
            options,
          )
        : calendar.createAllDayEvent(
            want.title,
            day(want.when.firstDay),
            day(addDays(want.when.lastDay, 1)),
            options,
          );
    return event.getId();
  };
  let removed = false;
  try {
    switch (op.kind) {
      case 'forget':
        return { op };
      case 'create':
        return { op, eventId: create(op.want) };
      case 'delete':
        calendar.getEventById(op.row.eventId!)?.deleteEvent();
        return { op };
      case 'replace':
        // Someone else's now (or their email changed): a new invitation.
        calendar.getEventById(op.row.eventId!)?.deleteEvent();
        removed = true;
        return { op, eventId: create(op.want) };
      case 'update': {
        const event = calendar.getEventById(op.row.eventId!);
        // Deleted from the app's calendar by hand: add it again.
        if (!event) return { op, eventId: create(op.want) };
        const { when } = op.want;
        if ('start' in when) event.setTime(new Date(when.start), new Date(when.end));
        else event.setAllDayDates(day(when.firstDay), day(addDays(when.lastDay, 1)));
        event.setTitle(op.want.title);
        event.setDescription(op.want.description);
        return { op, eventId: op.row.eventId };
      }
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const key = 'want' in op ? op.want.key : op.row.key;
    console.warn(`Google Calendar: couldn't ${op.kind} ${key}: ${error}`);
    return { op, error, ...(removed ? { eventId: null } : {}) };
  }
}

/** Save what happened: one row per key, with failures retried later. */
function record(db: Db, results: Result[], calendarIsNew: boolean): void {
  const t = tables(db).calendarEvents;
  const now = db.now;
  const touched = new Set<string>();
  const retryAfter = (attempts: number) =>
    iso(ms(now) + (BACKOFF_MINUTES[attempts - 1] ?? 360) * 60_000);
  for (const { op, eventId, error } of results) {
    const row = op.row ? t.get(op.row.id) : undefined;
    if (op.kind === 'forget' || (op.kind === 'delete' && !error)) {
      if (row) t.delete(row.id);
      continue;
    }
    const want = op.kind === 'delete' ? null : op.want;
    if (error) {
      const attempts = (row?.attempts ?? 0) + 1;
      const failure = {
        attempts,
        lastError: error.slice(0, 500),
        retryAfter: retryAfter(attempts),
      };
      // A replace that removed the old event but couldn't add the new one.
      const moved =
        want && eventId === null ? { userId: want.userId, email: want.email, eventId: null } : {};
      if (row) touched.add(t.update(row.id, { ...failure, ...moved }).key);
      else if (want) {
        touched.add(want.key);
        t.insert({
          key: want.key,
          userId: want.userId,
          email: want.email,
          signature: '',
          endsAt: want.endsAt,
          ...failure,
        });
      }
      continue;
    }
    const saved = {
      userId: want!.userId,
      email: want!.email,
      eventId: eventId ?? null,
      signature: want!.signature,
      endsAt: want!.endsAt,
      attempts: 0,
      lastError: null,
      retryAfter: null,
    };
    touched.add(want!.key);
    if (row) t.update(row.id, saved);
    else t.insert({ key: want!.key, ...saved });
  }
  // A new calendar (the old one was deleted, or someone else runs the app
  // now): everything else has to be added to it again.
  if (calendarIsNew) {
    for (const row of t.all()) {
      if (!touched.has(row.key) && row.eventId && ms(row.endsAt) > ms(now)) {
        t.update(row.id, { eventId: null, signature: '' });
      }
    }
  }
}

/**
 * Bring people's calendars up to date. Planning and saving take the script
 * lock; talking to Google Calendar doesn't, so the app stays quick meanwhile.
 * Returns how many changes were made.
 */
export function syncCalendars(): number {
  const lock = LockService.getScriptLock();
  const props = PropertiesService.getScriptProperties();
  if (!lock.tryLock(10_000)) return 0;
  let ops: Op[];
  let orgName: string;
  try {
    if (Number(props.getProperty(LEASE) ?? 0) > Date.now()) return 0;
    const db = new Db();
    ops = planCalendarSync(db, db.now);
    if (!ops.length) return 0;
    orgName = getSettings(db).orgName;
    props.setProperty(LEASE, String(Date.now() + LEASE_MS));
  } finally {
    lock.releaseLock();
  }

  let results: Result[];
  let isNew: boolean;
  try {
    const opened = ops.every((op) => op.kind === 'forget') ? null : appCalendar(orgName);
    isNew = opened?.isNew ?? false;
    results = ops.map((op, i) => {
      if (i > 0 && op.kind !== 'forget') Utilities.sleep(100);
      return opened ? run(opened.calendar, op) : { op };
    });
  } catch (err) {
    // No way into Google Calendar (e.g. its permission wasn't given): run
    // setup() to allow it. Pause instead of trying after every change.
    console.error(`Google Calendar: ${err instanceof Error ? err.message : String(err)}`);
    props.setProperty(LEASE, String(Date.now() + PAUSE_MS));
    return 0;
  }

  // Calendars have changed: wait as long as it takes to write that down, or
  // the next run would make the same changes again (adding events twice).
  try {
    lock.waitLock(120_000);
  } catch (err) {
    console.error(
      `Google Calendar: too busy to save what changed, so some events may be added twice (${err instanceof Error ? err.message : String(err)})`,
    );
    return 0;
  }
  try {
    const db = new Db();
    record(db, results, isNew);
    db.commit();
    props.deleteProperty(LEASE);
  } finally {
    lock.releaseLock();
  }
  return results.filter((r) => !r.error && r.op.kind !== 'forget').length;
}

/**
 * Hourly: if the app's calendar is gone (deleted by hand, or someone else
 * runs the app now and can't see it), start over: the next sync makes a new
 * one and adds everything upcoming to it.
 */
export function checkAppCalendar(db: Db): boolean {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty(CALENDAR_ID);
  const t = tables(db).calendarEvents;
  const upcoming = t.where((r) => r.eventId !== null && ms(r.endsAt) > ms(db.now));
  if (!id || !upcoming.length) return false;
  try {
    if (CalendarApp.getCalendarById(id)) return false;
  } catch {
    return false; // no access to Google Calendar at all: syncing says so
  }
  props.deleteProperty(CALENDAR_ID);
  for (const row of upcoming) t.update(row.id, { eventId: null, signature: '' });
  return true;
}

/** Hourly: forget rows for events that ended a while ago (they stay on calendars). */
export function forgetOldCalendarEvents(db: Db): number {
  const t = tables(db).calendarEvents;
  const before = ms(db.now) - KEEP_DAYS * DAY_MS;
  const old = t.where((r) => ms(r.endsAt) < before);
  for (const row of old) t.delete(row.id);
  return old.length;
}

/** Whether anyone's calendar might need changes after a change to the schedule. */
export function calendarsInUse(db: Db): boolean {
  return tables(db).users.find((u) => u.calendarSync && !u.deactivatedAt) !== undefined;
}
