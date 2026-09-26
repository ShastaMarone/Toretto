import type { PublishResult, ShiftStatus } from '@shared/types';
import type { AuthUser } from '../auth/types';
import type { Config } from '../config';
import { withTransaction, type Db, type Queryable } from '../db';
import { badRequest } from '../errors';
import { enqueueEmail, type NotificationKind } from '../email/outbox';
import { scheduleTemplate, type EmailShift } from '../email/templates';
import { audit } from './audit';
import { lockSchedule, scheduleTitle, type LockedSchedule } from './schedules';
import { getSettings, zoneFor } from './settings';

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
  opts: { firstPublish: boolean; kind?: NotificationKind },
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
  const { rows: tierRows } = await client.query<{ color: string }>(
    'SELECT color FROM tiers WHERE id = $1',
    [schedule.tierId],
  );
  const tierColor = tierRows[0]?.color ?? '#4f46e5';
  const toEmailShift = (s: Snapshot): EmailShift => {
    const label = s.labelId ? labels.get(s.labelId) : undefined;
    return {
      id: s.id,
      startTime: s.startTime,
      endTime: s.endTime,
      labelName: label?.name ?? null,
      labelColor: label?.color ?? null,
      tierName: schedule.tierName,
      tierColor,
      notes: s.notes,
      needsConfirmation: s.needsConfirmation,
    };
  };

  const { rows: people } = await client.query<{
    id: string;
    name: string;
    email: string;
    timezone: string | null;
  }>(
    `SELECT id, name, email, timezone FROM users
      WHERE id = ANY($1) AND deactivated_at IS NULL`,
    [[...changes.keys()]],
  );

  let queued = 0;
  for (const person of people) {
    const c = changes.get(person.id)!;
    const added = c.added.filter(upcoming);
    const updated = c.updated.filter((u) => upcoming(u.after));
    const removed = c.removed.filter(upcoming);
    if (!added.length && !updated.length && !removed.length) continue;
    const kind: NotificationKind =
      opts.kind ??
      (!added.length && !updated.length
        ? 'schedule_cancelled'
        : opts.firstPublish
          ? 'schedule_published'
          : 'schedule_updated');
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
          tz: zoneFor(person, settings),
          tierName: schedule.tierName,
          startDate: schedule.startDate,
          endDate: schedule.endDate,
          scheduleId: schedule.id,
          firstPublish: opts.firstPublish,
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

export async function publishSchedule(
  db: Db,
  config: Config,
  scheduleId: string,
  actor: AuthUser,
): Promise<PublishResult> {
  return withTransaction(db, async (client) => {
    const schedule = await lockSchedule(client, scheduleId);
    const firstPublish = schedule.status === 'draft';
    const { rows } = await client.query<RawShift>(
      `SELECT id, user_id, label_id, start_time, end_time, notes, status, published_at,
              published_user_id, published_label_id, published_start_time, published_end_time,
              published_notes, deleted_at
         FROM shifts WHERE schedule_id = $1
        ORDER BY start_time
          FOR UPDATE`,
      [scheduleId],
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
    await client.query(
      `UPDATE schedules SET status = 'published', published_at = now(), published_by = $2
        WHERE id = $1`,
      [scheduleId, actor.id],
    );

    result.emailsQueued = await notifyPeople(client, config, schedule, changes, { firstPublish });
    await audit(
      client,
      actor.id,
      'schedule.published',
      { type: 'schedule', id: scheduleId },
      {
        title: scheduleTitle(schedule),
        firstPublish,
        added: result.added,
        updated: result.updated,
        removed: result.removed,
        emails: result.emailsQueued,
      },
    );
    return result;
  });
}

/** Throw away unpublished edits, restoring the version the team currently sees. */
export async function discardChanges(db: Db, scheduleId: string, actor: AuthUser): Promise<void> {
  await withTransaction(db, async (client) => {
    const schedule = await lockSchedule(client, scheduleId);
    if (schedule.status === 'draft') {
      throw badRequest(
        "This schedule hasn't been published yet, so there's no published version to go back to.",
      );
    }
    const { rowCount: removed } = await client.query(
      'DELETE FROM shifts WHERE schedule_id = $1 AND published_at IS NULL',
      [scheduleId],
    );
    const { rowCount: reverted } = await client.query(
      `UPDATE shifts
          SET user_id = published_user_id, label_id = published_label_id,
              start_time = published_start_time, end_time = published_end_time,
              notes = published_notes, deleted_at = NULL
        WHERE schedule_id = $1 AND published_at IS NOT NULL
          AND (deleted_at IS NOT NULL
               OR user_id IS DISTINCT FROM published_user_id
               OR label_id IS DISTINCT FROM published_label_id
               OR start_time IS DISTINCT FROM published_start_time
               OR end_time IS DISTINCT FROM published_end_time
               OR notes IS DISTINCT FROM published_notes)`,
      [scheduleId],
    );
    await audit(
      client,
      actor.id,
      'schedule.changes_discarded',
      { type: 'schedule', id: scheduleId },
      {
        title: scheduleTitle(schedule),
        discarded: (removed ?? 0) + (reverted ?? 0),
      },
    );
  });
}

/** Delete a schedule. If it was published, everyone with upcoming shifts is told. */
export async function deleteSchedule(
  db: Db,
  config: Config,
  scheduleId: string,
  actor: AuthUser,
): Promise<{ notified: number }> {
  return withTransaction(db, async (client) => {
    const schedule = await lockSchedule(client, scheduleId);
    let notified = 0;
    if (schedule.status === 'published') {
      const { rows } = await client.query<RawShift>(
        `SELECT id, user_id, label_id, start_time, end_time, notes, status, published_at,
                published_user_id, published_label_id, published_start_time, published_end_time,
                published_notes, deleted_at
           FROM shifts WHERE schedule_id = $1 AND published_at IS NOT NULL
          ORDER BY published_start_time`,
        [scheduleId],
      );
      const changes = new Map<string, PersonChanges>();
      for (const s of rows) {
        const userId = s.published_user_id!;
        if (!changes.has(userId)) changes.set(userId, { added: [], updated: [], removed: [] });
        changes.get(userId)!.removed.push(published(s));
      }
      notified = await notifyPeople(client, config, schedule, changes, {
        firstPublish: false,
        kind: 'schedule_cancelled',
      });
    }
    await client.query('DELETE FROM schedules WHERE id = $1', [scheduleId]);
    await audit(
      client,
      actor.id,
      'schedule.deleted',
      { type: 'schedule', id: scheduleId },
      {
        title: scheduleTitle(schedule),
        wasPublished: schedule.status === 'published',
        notified,
      },
    );
    return { notified };
  });
}
