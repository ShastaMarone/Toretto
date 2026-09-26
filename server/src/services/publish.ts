import { formatDateRange, formatShiftWhen, localDate } from '@shared/time';
import type { PublishResult, ShiftStatus, TimeFormat } from '@shared/types';
import type { AuthUser } from '../auth/types';
import type { Config } from '../config';
import { withTransaction, type Db, type Queryable } from '../db';
import { badRequest, conflict } from '../errors';
import { enqueueEmail, type NotificationKind } from '../email/outbox';
import { scheduleTemplate, type EmailShift } from '../email/templates';
import { audit } from './audit';
import {
  IN_RANGE,
  lockSchedule,
  rangeBounds,
  type DateRange,
  type LockedSchedule,
} from './schedules';
import { getSettings, timeFormatFor, zoneFor } from './settings';

interface Snapshot {
  id: string;
  userId: string;
  labelId: string | null;
  startTime: string;
  endTime: string;
  notes: string | null;
  needsConfirmation: boolean;
}

interface PersonChanges {
  added: Snapshot[];
  updated: { before: Snapshot; after: Snapshot }[];
  removed: Snapshot[];
}

interface RawShift {
  id: string;
  user_id: string;
  label_id: string | null;
  start_time: string;
  end_time: string;
  notes: string | null;
  status: ShiftStatus;
  published_at: string | null;
  published_user_id: string | null;
  published_label_id: string | null;
  published_start_time: string | null;
  published_end_time: string | null;
  published_notes: string | null;
  deleted_at: string | null;
}

const RAW_COLUMNS = `s.id, s.user_id, s.label_id, s.start_time, s.end_time, s.notes, s.status,
  s.published_at, s.published_user_id, s.published_label_id, s.published_start_time,
  s.published_end_time, s.published_notes, s.deleted_at`;

const sameInstant = (a: string, b: string) => Date.parse(a) === Date.parse(b);

function working(s: RawShift, needsConfirmation: boolean): Snapshot {
  return {
    id: s.id,
    userId: s.user_id,
    labelId: s.label_id,
    startTime: s.start_time,
    endTime: s.end_time,
    notes: s.notes,
    needsConfirmation,
  };
}

function published(s: RawShift): Snapshot {
  return {
    id: s.id,
    userId: s.published_user_id!,
    labelId: s.published_label_id,
    startTime: s.published_start_time!,
    endTime: s.published_end_time!,
    notes: s.published_notes,
    needsConfirmation: false,
  };
}

/** SQL condition and parameters limiting a query to a date range (or not). */
async function rangeFilter(
  client: Queryable,
  range: DateRange | null,
): Promise<{ where: string; params: string[]; label: string }> {
  if (!range) return { where: 'TRUE', params: [], label: 'all dates' };
  const { timezone } = await getSettings(client);
  const bounds = rangeBounds(range, timezone);
  return {
    where: IN_RANGE,
    params: [bounds.from, bounds.to],
    label: formatDateRange(range.from, range.to),
  };
}

/**
 * Queue one email per affected person describing their new, changed and
 * cancelled shifts. Shifts that already ended are left out; people with
 * nothing upcoming get no email.
 */
async function notifyPeople(
  client: Queryable,
  config: Config,
  schedule: LockedSchedule,
  changes: Map<string, PersonChanges>,
  opts: { kind?: NotificationKind } = {},
): Promise<number> {
  if (changes.size === 0) return 0;
  const settings = await getSettings(client);
  const nowMs = Date.now();
  const upcoming = (s: Snapshot) => Date.parse(s.endTime) > nowMs;

  const labelIds = new Set<string>();
  for (const c of changes.values()) {
    for (const s of [...c.added, ...c.removed, ...c.updated.flatMap((u) => [u.before, u.after])]) {
      if (s.labelId) labelIds.add(s.labelId);
    }
  }
  const { rows: labelRows } = await client.query<{ id: string; name: string; color: string }>(
    'SELECT id, name, color FROM labels WHERE id = ANY($1)',
    [[...labelIds]],
  );
  const labels = new Map(labelRows.map((l) => [l.id, l]));
  const { rows: counts } = await client.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM schedules',
  );
  // Only name the schedule when there's more than one to tell apart.
  const scheduleName = (counts[0]?.n ?? 1) > 1 ? schedule.name : null;

  const { rows: people } = await client.query<{
    id: string;
    name: string;
    email: string;
    timezone: string | null;
    timeFormat: TimeFormat | null;
    tierColor: string | null;
  }>(
    `SELECT u.id, u.name, u.email, u.timezone, u.time_format AS "timeFormat",
            t.color AS "tierColor"
       FROM users u LEFT JOIN tiers t ON t.id = u.tier_id
      WHERE u.id = ANY($1) AND u.deactivated_at IS NULL`,
    [[...changes.keys()]],
  );

  let queued = 0;
  for (const person of people) {
    const c = changes.get(person.id)!;
    const added = c.added.filter(upcoming);
    // Moving a future shift into the past still changes someone's upcoming week.
    const updated = c.updated.filter((u) => upcoming(u.after) || upcoming(u.before));
    const removed = c.removed.filter(upcoming);
    if (!added.length && !updated.length && !removed.length) continue;
    const tz = zoneFor(person, settings);
    const toEmailShift = (s: Snapshot): EmailShift => {
      const label = s.labelId ? labels.get(s.labelId) : undefined;
      return {
        id: s.id,
        startTime: s.startTime,
        endTime: s.endTime,
        labelName: label?.name ?? null,
        color: label?.color ?? person.tierColor,
        notes: s.notes,
        needsConfirmation: s.needsConfirmation,
      };
    };
    const days = [...added, ...removed, ...updated.flatMap((u) => [u.before, u.after])]
      .map((s) => localDate(s.startTime, tz))
      .sort();
    const kind: NotificationKind =
      opts.kind ??
      (!added.length && !updated.length
        ? 'schedule_cancelled'
        : updated.length || removed.length
          ? 'schedule_updated'
          : 'schedule_published');
    await enqueueEmail(client, {
      userId: person.id,
      to: person.email,
      kind,
      scheduleId: schedule.id,
      shiftIds: [...added, ...updated.map((u) => u.after), ...removed].map((s) => s.id),
      email: scheduleTemplate(
        { orgName: settings.orgName, appUrl: config.appUrl },
        {
          recipientName: person.name,
          tz,
          timeFormat: timeFormatFor(person, settings),
          scheduleName,
          startDate: days[0]!,
          endDate: days[days.length - 1]!,
          added: added.map(toEmailShift),
          updated: updated.map((u) => ({
            before: toEmailShift(u.before),
            after: toEmailShift(u.after),
          })),
          removed: removed.map(toEmailShift),
        },
      ),
    });
    queued++;
  }
  return queued;
}

/**
 * Publish the unpublished changes in a date range (or everywhere): the team
 * sees the new version, and everyone affected gets one email.
 */
export async function publishSchedule(
  db: Db,
  config: Config,
  scheduleId: string,
  actor: AuthUser,
  range: DateRange | null,
): Promise<PublishResult> {
  return withTransaction(db, async (client) => {
    const schedule = await lockSchedule(client, scheduleId);
    const filter = await rangeFilter(client, range);
    const { rows } = await client.query<RawShift>(
      `SELECT ${RAW_COLUMNS} FROM shifts s
        WHERE s.schedule_id = $1 AND ${filter.where}
        ORDER BY s.start_time
          FOR UPDATE`,
      [scheduleId, ...filter.params],
    );

    const changes = new Map<string, PersonChanges>();
    const forPerson = (userId: string) => {
      let c = changes.get(userId);
      if (!c) changes.set(userId, (c = { added: [], updated: [], removed: [] }));
      return c;
    };
    const toDelete: string[] = [];
    const resetIds: string[] = [];
    const notesOnlyIds: string[] = [];
    const result: PublishResult = {
      added: 0,
      updated: 0,
      removed: 0,
      unchanged: 0,
      emailsQueued: 0,
    };

    for (const s of rows) {
      if (s.deleted_at) {
        toDelete.push(s.id);
        if (s.published_at) {
          result.removed++;
          forPerson(s.published_user_id!).removed.push(published(s));
        }
        continue;
      }
      if (!s.published_at) {
        result.added++;
        resetIds.push(s.id);
        forPerson(s.user_id).added.push(working(s, true));
        continue;
      }
      const material =
        s.user_id !== s.published_user_id ||
        s.label_id !== s.published_label_id ||
        !sameInstant(s.start_time, s.published_start_time!) ||
        !sameInstant(s.end_time, s.published_end_time!);
      const notesChanged = (s.notes ?? null) !== (s.published_notes ?? null);
      if (!material && !notesChanged) {
        result.unchanged++;
        continue;
      }
      result.updated++;
      (material ? resetIds : notesOnlyIds).push(s.id);
      if (s.user_id !== s.published_user_id) {
        // Reassigned: it's cancelled for one person and new for another.
        forPerson(s.published_user_id!).removed.push(published(s));
        forPerson(s.user_id).added.push(working(s, true));
      } else {
        forPerson(s.user_id).updated.push({
          before: published(s),
          after: working(s, material || s.status === 'pending'),
        });
      }
    }

    if (toDelete.length) {
      await client.query('DELETE FROM shifts WHERE id = ANY($1)', [toDelete]);
    }
    if (resetIds.length) {
      await client.query(
        `UPDATE shifts
            SET published_at = now(), published_user_id = user_id, published_label_id = label_id,
                published_start_time = start_time, published_end_time = end_time,
                published_notes = notes, status = 'pending', confirmed_at = NULL,
                reminder_sent_at = NULL
          WHERE id = ANY($1)`,
        [resetIds],
      );
    }
    if (notesOnlyIds.length) {
      await client.query('UPDATE shifts SET published_notes = notes WHERE id = ANY($1)', [
        notesOnlyIds,
      ]);
    }
    const changed = result.added + result.updated + result.removed;
    if (changed) {
      await client.query(
        'UPDATE schedules SET published_at = now(), published_by = $2 WHERE id = $1',
        [scheduleId, actor.id],
      );
    }

    result.emailsQueued = await notifyPeople(client, config, schedule, changes);
    if (changed) {
      await audit(
        client,
        actor.id,
        'schedule.published',
        { type: 'schedule', id: scheduleId },
        {
          title: schedule.name,
          range: filter.label,
          added: result.added,
          updated: result.updated,
          removed: result.removed,
          emails: result.emailsQueued,
        },
      );
    }
    return result;
  });
}

/**
 * Throw away unpublished edits in a date range (or everywhere), restoring
 * the version the team currently sees. Never-published shifts are deleted.
 */
export async function discardChanges(
  db: Db,
  scheduleId: string,
  actor: AuthUser,
  range: DateRange | null,
): Promise<{ discarded: number }> {
  return withTransaction(db, async (client) => {
    const schedule = await lockSchedule(client, scheduleId);
    const filter = await rangeFilter(client, range);
    // Lock everyone whose published shifts come back, in a stable order, so no
    // concurrent edit elsewhere can slip an overlapping shift in meanwhile.
    const { rows: people } = await client.query<{ userId: string }>(
      `SELECT DISTINCT s.published_user_id AS "userId" FROM shifts s
        WHERE s.schedule_id = $1 AND s.published_at IS NOT NULL AND ${filter.where}
        ORDER BY 1`,
      [scheduleId, ...filter.params],
    );
    for (const { userId } of people) {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`shifts:${userId}`]);
    }
    const { rowCount: removed } = await client.query(
      `DELETE FROM shifts s WHERE s.schedule_id = $1 AND s.published_at IS NULL AND ${filter.where}`,
      [scheduleId, ...filter.params],
    );
    const { rows: reverted } = await client.query<{ id: string }>(
      `UPDATE shifts s
          SET user_id = published_user_id, label_id = published_label_id,
              start_time = published_start_time, end_time = published_end_time,
              notes = published_notes, deleted_at = NULL
        WHERE s.schedule_id = $1 AND s.published_at IS NOT NULL AND ${filter.where}
          AND (s.deleted_at IS NOT NULL
               OR s.user_id IS DISTINCT FROM s.published_user_id
               OR s.label_id IS DISTINCT FROM s.published_label_id
               OR s.start_time IS DISTINCT FROM s.published_start_time
               OR s.end_time IS DISTINCT FROM s.published_end_time
               OR s.notes IS DISTINCT FROM s.published_notes)
        RETURNING s.id`,
      [scheduleId, ...filter.params],
    );
    // A restored shift may now collide with one added elsewhere in the meantime.
    const { rows: clashes } = await client.query<{
      name: string;
      startTime: string;
      endTime: string;
    }>(
      `SELECT u.name, a.start_time AS "startTime", a.end_time AS "endTime"
         FROM shifts a
         JOIN shifts b ON b.user_id = a.user_id AND b.id <> a.id AND b.deleted_at IS NULL
                      AND a.start_time < b.end_time AND a.end_time > b.start_time
         JOIN users u ON u.id = a.user_id
        WHERE a.id = ANY($1)
        ORDER BY a.start_time
        LIMIT 1`,
      [reverted.map((r) => r.id)],
    );
    if (clashes[0]) {
      const { timezone, timeFormat } = await getSettings(client);
      throw conflict(
        `Can't discard: ${clashes[0].name} would be double-booked ${formatShiftWhen(clashes[0].startTime, clashes[0].endTime, timezone, timeFormat)}. Move or remove their other shift first.`,
        'SHIFT_OVERLAP',
      );
    }
    const discarded = (removed ?? 0) + reverted.length;
    if (discarded) {
      await audit(
        client,
        actor.id,
        'schedule.changes_discarded',
        { type: 'schedule', id: scheduleId },
        { title: schedule.name, range: filter.label, discarded },
      );
    }
    return { discarded };
  });
}

/** Delete an extra schedule. Everyone with upcoming published shifts on it is told. */
export async function deleteSchedule(
  db: Db,
  config: Config,
  scheduleId: string,
  actor: AuthUser,
): Promise<{ notified: number }> {
  return withTransaction(db, async (client) => {
    const schedule = await lockSchedule(client, scheduleId);
    if (schedule.isDefault) throw badRequest("The main schedule can't be deleted");
    const { rows } = await client.query<RawShift>(
      `SELECT ${RAW_COLUMNS} FROM shifts s
        WHERE s.schedule_id = $1 AND s.published_at IS NOT NULL
        ORDER BY s.published_start_time`,
      [scheduleId],
    );
    const changes = new Map<string, PersonChanges>();
    for (const s of rows) {
      const userId = s.published_user_id!;
      if (!changes.has(userId)) changes.set(userId, { added: [], updated: [], removed: [] });
      changes.get(userId)!.removed.push(published(s));
    }
    const notified = await notifyPeople(client, config, schedule, changes, {
      kind: 'schedule_cancelled',
    });
    await client.query('DELETE FROM schedules WHERE id = $1', [scheduleId]);
    await audit(
      client,
      actor.id,
      'schedule.deleted',
      { type: 'schedule', id: scheduleId },
      { title: schedule.name, notified },
    );
    return { notified };
  });
}
