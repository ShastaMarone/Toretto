import type { ShiftSwap, SwapOption, SwapShift, SwapStatus } from '@shared/types';
import type { AuthUser } from '../auth/types';
import type { Config } from '../config';
import { withTransaction, type Db, type Queryable } from '../db';
import {
  swapAcceptedTemplate,
  swapCancelledTemplate,
  swapDeclinedTemplate,
  swapRequestedTemplate,
  swapReviewedTemplate,
  type EmailShift,
} from '../email/templates';
import { badRequest, conflict, notFound } from '../errors';
import { audit } from './audit';
import { busyBetween, busyReason } from './availability';
import { notifyAdmins, notifyPerson } from './notify';
import { lockSchedule } from './schedules';

/** How far ahead a coworker's shifts are offered for a trade. */
const TRADE_DAYS = 60;

/** A shift as published, joined as `p` (with its schedule, label and owner's tier). */
const shiftColumns = (p: string) => `
  ${p}.id AS "${p}Id", ${p}.published_start_time AS "${p}Start",
  ${p}.published_end_time AS "${p}End", ${p}_l.name AS "${p}Label",
  COALESCE(${p}_l.color, ${p}_t.color) AS "${p}Color", ${p}_sc.name AS "${p}Schedule"`;
const shiftJoins = (p: string, on: string, join = 'JOIN') => `
  ${join} shifts ${p} ON ${p}.id = ${on}
  LEFT JOIN schedules ${p}_sc ON ${p}_sc.id = ${p}.schedule_id
  LEFT JOIN labels ${p}_l ON ${p}_l.id = ${p}.published_label_id
  LEFT JOIN users ${p}_u ON ${p}_u.id = ${p}.published_user_id
  LEFT JOIN tiers ${p}_t ON ${p}_t.id = ${p}_u.tier_id`;

const SWAP_SQL = `
  SELECT w.id, w.status, w.note, w.review_note AS "reviewNote", rb.name AS "reviewedByName",
         w.created_at AS "createdAt", w.responded_at AS "respondedAt",
         w.reviewed_at AS "reviewedAt",
         w.requester_id AS "requesterId", ru.name AS "requesterName",
         w.recipient_id AS "recipientId", cu.name AS "recipientName",
         ${shiftColumns('s1')}, ${shiftColumns('s2')}
    FROM shift_swaps w
    JOIN users ru ON ru.id = w.requester_id
    JOIN users cu ON cu.id = w.recipient_id
    ${shiftJoins('s1', 'w.shift_id')}
    ${shiftJoins('s2', 'w.return_shift_id', 'LEFT JOIN')}
    LEFT JOIN users rb ON rb.id = w.reviewed_by`;

interface SwapRow {
  id: string;
  status: SwapStatus;
  note: string | null;
  reviewNote: string | null;
  reviewedByName: string | null;
  createdAt: string;
  respondedAt: string | null;
  reviewedAt: string | null;
  requesterId: string;
  requesterName: string;
  recipientId: string;
  recipientName: string;
  s1Id: string;
  s1Start: string;
  s1End: string;
  s1Label: string | null;
  s1Color: string | null;
  s1Schedule: string;
  s2Id: string | null;
  s2Start: string | null;
  s2End: string | null;
  s2Label: string | null;
  s2Color: string | null;
  s2Schedule: string | null;
}

function toSwap(r: SwapRow): ShiftSwap {
  return {
    id: r.id,
    status: r.status,
    requester: { id: r.requesterId, name: r.requesterName },
    recipient: { id: r.recipientId, name: r.recipientName },
    shift: {
      id: r.s1Id,
      startTime: r.s1Start,
      endTime: r.s1End,
      labelName: r.s1Label,
      color: r.s1Color,
      scheduleName: r.s1Schedule,
    },
    returnShift: r.s2Id
      ? {
          id: r.s2Id,
          startTime: r.s2Start!,
          endTime: r.s2End!,
          labelName: r.s2Label,
          color: r.s2Color,
          scheduleName: r.s2Schedule!,
        }
      : null,
    note: r.note,
    reviewNote: r.reviewNote,
    reviewedByName: r.reviewedByName,
    createdAt: r.createdAt,
    respondedAt: r.respondedAt,
    reviewedAt: r.reviewedAt,
  };
}

/** A swap `w` whose shifts are still the published versions it's about, with the same owners. */
const CURRENT = `
  EXISTS (SELECT 1 FROM shifts a
           WHERE a.id = w.shift_id AND a.published_at IS NOT NULL
             AND a.published_user_id = w.requester_id
             AND (w.shift_version IS NULL OR a.published_at = w.shift_version))
  AND (w.return_shift_id IS NULL OR EXISTS (
         SELECT 1 FROM shifts b
          WHERE b.id = w.return_shift_id AND b.published_at IS NOT NULL
            AND b.published_user_id = w.recipient_id
            AND (w.return_version IS NULL OR b.published_at = w.return_version)))`;

/**
 * Open swaps lapse: 'expired' once one of their shifts starts, 'changed' once
 * one is republished with a different person, time or label (its published_at
 * moves on). Rows another request is working on are left for next time.
 */
async function settleOpenSwaps(db: Queryable): Promise<void> {
  await db.query(
    `UPDATE shift_swaps SET status = 'expired'
      WHERE id IN (
        SELECT w.id FROM shift_swaps w
         WHERE w.status IN ('pending', 'accepted')
           AND EXISTS (SELECT 1 FROM shifts s
                        WHERE s.id IN (w.shift_id, w.return_shift_id)
                          AND s.published_start_time <= now())
         ORDER BY w.id
           FOR UPDATE SKIP LOCKED)`,
  );
  await db.query(
    `UPDATE shift_swaps SET status = 'changed'
      WHERE id IN (
        SELECT w.id FROM shift_swaps w
         WHERE w.status IN ('pending', 'accepted') AND NOT (${CURRENT})
         ORDER BY w.id
           FOR UPDATE SKIP LOCKED)`,
  );
}

export async function getSwap(db: Queryable, id: string): Promise<ShiftSwap> {
  const { rows } = await db.query<SwapRow>(`${SWAP_SQL} WHERE w.id = $1`, [id]);
  if (!rows[0]) throw notFound('Swap');
  return toSwap(rows[0]);
}

/** Swaps someone offered or was asked to take: open ones, and the last month's others. */
export async function listMySwaps(db: Queryable, userId: string): Promise<ShiftSwap[]> {
  await settleOpenSwaps(db);
  const { rows } = await db.query<SwapRow>(
    `${SWAP_SQL}
      WHERE (w.requester_id = $1 OR w.recipient_id = $1)
        AND (w.status IN ('pending', 'accepted') OR w.updated_at > now() - interval '30 days')
      ORDER BY w.created_at DESC
      LIMIT 50`,
    [userId],
  );
  return rows.map(toSwap);
}

/** For admins: waiting for approval first, then waiting for the coworker, then the rest. */
export async function listSwaps(db: Queryable): Promise<ShiftSwap[]> {
  await settleOpenSwaps(db);
  const { rows } = await db.query<SwapRow>(
    `${SWAP_SQL}
      ORDER BY (w.status = 'accepted') DESC, (w.status = 'pending') DESC, w.created_at DESC
      LIMIT 200`,
  );
  return rows.map(toSwap);
}

interface PublishedShift {
  id: string;
  scheduleId: string;
  userId: string;
  startTime: string;
  endTime: string;
  labelName: string | null;
  color: string | null;
  notes: string | null;
  /** Its published_at as text, which keeps the microseconds a Date would drop. */
  version: string;
  /** Removed in the builder, but not published yet. */
  deleted: boolean;
  /** The admin's working copy differs from what's published. */
  changed: boolean;
}

/**
 * Published shifts by id. With `lock`, their rows are locked in the same
 * order as publishing (start time), after their schedules.
 */
async function publishedShifts(
  db: Queryable,
  ids: string[],
  lock = false,
): Promise<Map<string, PublishedShift>> {
  if (lock) {
    const { rows } = await db.query<{ id: string }>(
      'SELECT DISTINCT schedule_id AS id FROM shifts WHERE id = ANY($1) ORDER BY 1',
      [ids],
    );
    for (const schedule of rows) await lockSchedule(db, schedule.id);
  }
  const { rows } = await db.query<PublishedShift>(
    `SELECT s.id, s.schedule_id AS "scheduleId", s.published_user_id AS "userId",
            s.published_start_time AS "startTime", s.published_end_time AS "endTime",
            l.name AS "labelName", COALESCE(l.color, t.color) AS color,
            s.published_notes AS notes, s.published_at::text AS version,
            (s.deleted_at IS NOT NULL) AS deleted,
            (s.user_id <> s.published_user_id OR s.start_time <> s.published_start_time
             OR s.end_time <> s.published_end_time
             OR s.label_id IS DISTINCT FROM s.published_label_id
             OR s.notes IS DISTINCT FROM s.published_notes) AS changed
       FROM shifts s
       LEFT JOIN labels l ON l.id = s.published_label_id
       LEFT JOIN users u ON u.id = s.published_user_id
       LEFT JOIN tiers t ON t.id = u.tier_id
      WHERE s.id = ANY($1) AND s.published_at IS NOT NULL
      ORDER BY s.start_time
      ${lock ? 'FOR UPDATE OF s' : ''}`,
    [ids],
  );
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * Someone's published shift that hasn't started; "not found" otherwise. (An
 * unpublished removal isn't given away: approving waits for it instead.)
 */
function upcoming(shift: PublishedShift | undefined, ownerId: string): PublishedShift {
  if (!shift || shift.userId !== ownerId) throw notFound('Shift');
  if (Date.parse(shift.startTime) <= Date.now()) {
    throw badRequest('That shift has already started');
  }
  return shift;
}

async function assertNotInOpenSwap(db: Queryable, shiftIds: string[]) {
  const { rows } = await db.query(
    `SELECT 1 FROM shift_swaps
      WHERE status IN ('pending', 'accepted')
        AND (shift_id = ANY($1) OR return_shift_id = ANY($1))
      LIMIT 1`,
    [shiftIds],
  );
  if (rows.length) {
    throw conflict('One of these shifts is already part of a swap', 'SWAP_EXISTS');
  }
}

interface Person {
  id: string;
  name: string;
  email: string;
  tierId: string | null;
  active: boolean;
  /** Has joined (confirmed their email), so they can answer. */
  joined: boolean;
  timezone: string | null;
  timeFormat: '12h' | '24h' | null;
}

async function loadPeople(db: Queryable, ids: string[]): Promise<Map<string, Person>> {
  const { rows } = await db.query<Person>(
    `SELECT id, name, email, tier_id AS "tierId", (deactivated_at IS NULL) AS active,
            (email_verified_at IS NOT NULL) AS joined, timezone, time_format AS "timeFormat"
       FROM users WHERE id = ANY($1)`,
    [ids],
  );
  return new Map(rows.map((p) => [p.id, p]));
}

/**
 * Both people can work their new shift: the coworker the offered one, and in
 * a trade the requester the coworker's (leaving out the shifts changing
 * hands). Team members only hear about published shifts; admins approving
 * also count drafts, under the builder's per-person locks.
 */
async function assertBothFree(
  db: Queryable,
  requester: Person,
  recipient: Person,
  shift: PublishedShift,
  returnShift: PublishedShift | null,
  opts: { admin: boolean },
): Promise<void> {
  if (opts.admin) {
    for (const id of [requester.id, recipient.id].sort()) {
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`shifts:${id}`]);
    }
  }
  const times = [shift, ...(returnShift ? [returnShift] : [])];
  const from = new Date(Math.min(...times.map((s) => Date.parse(s.startTime)))).toISOString();
  const to = new Date(Math.max(...times.map((s) => Date.parse(s.endTime)))).toISOString();
  const busy = await busyBetween(db, [requester.id, recipient.id], from, to, {
    drafts: opts.admin,
  });
  const ignore = times.map((s) => s.id);
  const theirs = busyReason(busy, recipient.id, shift.startTime, shift.endTime, ignore);
  if (theirs) {
    throw conflict(
      `${recipient.name} can't take it: ${theirs === 'Working then' ? 'they have another shift then' : "they're off then"}`,
      'SWAP_BUSY',
    );
  }
  const yours = returnShift
    ? busyReason(busy, requester.id, returnShift.startTime, returnShift.endTime, ignore)
    : null;
  if (yours) {
    throw conflict(
      `${requester.name} can't take ${recipient.name}'s shift: ${yours === 'Working then' ? 'they have another shift then' : "they're off then"}`,
      'SWAP_BUSY',
    );
  }
}

function assertSameTier(requester: Person, recipient: Person): void {
  if (!requester.tierId || requester.tierId !== recipient.tierId) {
    throw badRequest('Shifts can only be swapped with someone in the same tier', {
      recipientId: 'Not in your tier',
    });
  }
  if (!recipient.active) throw badRequest(`${recipient.name} is deactivated`);
  if (!recipient.joined) throw badRequest(`${recipient.name} hasn't joined yet`);
}

const emailShift = (s: {
  id: string;
  startTime: string;
  endTime: string;
  labelName: string | null;
  color: string | null;
  notes?: string | null;
}): EmailShift => ({
  id: s.id,
  startTime: s.startTime,
  endTime: s.endTime,
  labelName: s.labelName,
  color: s.color,
  notes: s.notes ?? null,
  needsConfirmation: false,
});

/** Coworkers in your tier who could take one of your shifts, and their shifts you could take back. */
export async function swapOptions(
  db: Queryable,
  user: AuthUser,
  shiftId: string,
): Promise<SwapOption[]> {
  const shift = upcoming((await publishedShifts(db, [shiftId])).get(shiftId), user.id);
  if (!user.tierId) return [];
  const { rows: people } = await db.query<{ id: string; name: string }>(
    `SELECT id, name FROM users
      WHERE tier_id = $1 AND id <> $2 AND deactivated_at IS NULL
        AND email_verified_at IS NOT NULL
      ORDER BY lower(name)`,
    [user.tierId, user.id],
  );
  if (!people.length) return [];
  const ids = people.map((p) => p.id);
  const now = new Date().toISOString();
  const horizon = new Date(Date.now() + TRADE_DAYS * 86_400_000).toISOString();
  const { rows: theirShifts } = await db.query<SwapShift & { userId: string }>(
    `SELECT s.id, s.published_user_id AS "userId", s.published_start_time AS "startTime",
            s.published_end_time AS "endTime", l.name AS "labelName",
            COALESCE(l.color, t.color) AS color, sc.name AS "scheduleName"
       FROM shifts s
       JOIN schedules sc ON sc.id = s.schedule_id
       JOIN users u ON u.id = s.published_user_id
       LEFT JOIN tiers t ON t.id = u.tier_id
       LEFT JOIN labels l ON l.id = s.published_label_id
      WHERE s.published_at IS NOT NULL AND s.published_user_id = ANY($1)
        AND s.published_start_time > $2 AND s.published_start_time < $3
        AND NOT EXISTS (SELECT 1 FROM shift_swaps w
                         WHERE w.status IN ('pending', 'accepted')
                           AND (w.shift_id = s.id OR w.return_shift_id = s.id))
      ORDER BY s.published_start_time`,
    [ids, now, horizon],
  );
  // What the team can see: published shifts and time off, never drafts.
  const busy = await busyBetween(
    db,
    [user.id, ...ids],
    now,
    new Date(Math.max(Date.parse(horizon), Date.parse(shift.endTime))).toISOString(),
    { drafts: false },
  );
  return people.map((p) => ({
    id: p.id,
    name: p.name,
    busy: busyReason(busy, p.id, shift.startTime, shift.endTime),
    shifts: theirShifts
      .filter(
        (s) =>
          s.userId === p.id &&
          !busyReason(busy, user.id, s.startTime, s.endTime, [shift.id]) &&
          !busyReason(busy, p.id, shift.startTime, shift.endTime, [s.id]),
      )
      .map(({ userId: _owner, ...s }) => s),
  }));
}

export async function requestSwap(
  db: Db,
  config: Config,
  user: AuthUser,
  input: {
    shiftId: string;
    recipientId: string;
    returnShiftId: string | null;
    note: string | null;
  },
): Promise<ShiftSwap> {
  const id = await withTransaction(db, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('swaps'))");
    await settleOpenSwaps(client);
    const ids = [input.shiftId, ...(input.returnShiftId ? [input.returnShiftId] : [])];
    const shifts = await publishedShifts(client, ids);
    const shift = upcoming(shifts.get(input.shiftId), user.id);
    const people = await loadPeople(client, [user.id, input.recipientId]);
    const requester = people.get(user.id)!;
    const recipient = people.get(input.recipientId);
    if (!recipient || recipient.id === user.id) throw notFound('Person');
    assertSameTier(requester, recipient);
    const returnShift = input.returnShiftId
      ? upcoming(shifts.get(input.returnShiftId), recipient.id)
      : null;
    await assertNotInOpenSwap(client, ids);
    await assertBothFree(client, requester, recipient, shift, returnShift, { admin: false });
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO shift_swaps
         (shift_id, requester_id, recipient_id, return_shift_id, note, shift_version, return_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        shift.id,
        user.id,
        recipient.id,
        returnShift?.id ?? null,
        input.note,
        shift.version,
        returnShift?.version ?? null,
      ],
    );
    const swapId = rows[0]!.id;
    await notifyPerson(client, config, recipient, {
      kind: 'swap_requested',
      shiftIds: ids,
      render: (ctx, prefs) =>
        swapRequestedTemplate(ctx, {
          recipientName: recipient.name,
          requesterName: requester.name,
          shift: emailShift(shift),
          returnShift: returnShift ? emailShift(returnShift) : null,
          note: input.note,
          ...prefs,
        }),
    });
    await audit(
      client,
      user.id,
      'swap.requested',
      { type: 'swap', id: swapId },
      {
        recipientName: recipient.name,
        startTime: shift.startTime,
        endTime: shift.endTime,
        trade: Boolean(returnShift),
      },
    );
    return swapId;
  });
  return getSwap(db, id);
}

/** Lock a swap's row and load its two people. */
async function lockSwap(db: Queryable, id: string) {
  const { rows } = await db.query<{
    id: string;
    status: SwapStatus;
    requesterId: string;
    recipientId: string;
    shiftId: string;
    returnShiftId: string | null;
    shiftVersion: string | null;
    returnVersion: string | null;
  }>(
    `SELECT id, status, requester_id AS "requesterId", recipient_id AS "recipientId",
            shift_id AS "shiftId", return_shift_id AS "returnShiftId",
            shift_version::text AS "shiftVersion", return_version::text AS "returnVersion"
       FROM shift_swaps WHERE id = $1 FOR UPDATE`,
    [id],
  );
  const swap = rows[0];
  if (!swap) throw notFound('Swap');
  const people = await loadPeople(db, [swap.requesterId, swap.recipientId]);
  return {
    ...swap,
    shiftIds: [swap.shiftId, ...(swap.returnShiftId ? [swap.returnShiftId] : [])],
    requester: people.get(swap.requesterId)!,
    recipient: people.get(swap.recipientId)!,
  };
}

const LAPSED: Partial<Record<SwapStatus, string>> = {
  expired: 'This swap expired: the shift has already started',
  changed: 'The schedule has changed since, so this swap no longer applies',
};

function assertStatus(status: SwapStatus, allowed: SwapStatus[]): void {
  if (!allowed.includes(status)) {
    throw conflict(LAPSED[status] ?? `This swap is already ${status}`, 'INVALID_STATUS');
  }
}

/**
 * The swap's shifts as published now, provided they're still the versions it's
 * about, with the same owners, and haven't started. (Settling marks the others
 * lapsed, but may have left this one to a request that was busy with it.)
 */
function stillCurrent(
  swap: Awaited<ReturnType<typeof lockSwap>>,
  shifts: Map<string, PublishedShift>,
): { shift: PublishedShift; returnShift: PublishedShift | null } {
  const current = (id: string, ownerId: string, version: string | null) => {
    const s = shifts.get(id);
    if (!s || s.userId !== ownerId || (version !== null && s.version !== version)) {
      throw conflict(LAPSED.changed!, 'SWAP_STALE');
    }
    if (Date.parse(s.startTime) <= Date.now()) throw conflict(LAPSED.expired!, 'SWAP_STALE');
    return s;
  };
  return {
    shift: current(swap.shiftId, swap.requesterId, swap.shiftVersion),
    returnShift: swap.returnShiftId
      ? current(swap.returnShiftId, swap.recipientId, swap.returnVersion)
      : null,
  };
}

/** The coworker says yes (admins are asked to approve) or no. */
export async function respondToSwap(
  db: Db,
  config: Config,
  user: AuthUser,
  swapId: string,
  answer: 'accept' | 'decline',
): Promise<ShiftSwap> {
  await withTransaction(db, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('swaps'))");
    await settleOpenSwaps(client);
    const swap = await lockSwap(client, swapId);
    if (swap.recipientId !== user.id) throw notFound('Swap');
    assertStatus(swap.status, ['pending']);
    const { shift, returnShift } = stillCurrent(swap, await publishedShifts(client, swap.shiftIds));
    if (answer === 'accept') {
      await assertBothFree(client, swap.requester, swap.recipient, shift, returnShift, {
        admin: false,
      });
    }
    await client.query('UPDATE shift_swaps SET status = $2, responded_at = now() WHERE id = $1', [
      swapId,
      answer === 'accept' ? 'accepted' : 'declined',
    ]);
    if (answer === 'accept') {
      await notifyAdmins(client, config, {
        topic: 'swaps',
        exceptUserId: user.id,
        kind: 'swap_accepted',
        shiftIds: swap.shiftIds,
        render: (ctx, admin) =>
          swapAcceptedTemplate(ctx, {
            recipientName: admin.name,
            requesterName: swap.requester.name,
            takerName: swap.recipient.name,
            shift: emailShift(shift),
            returnShift: returnShift ? emailShift(returnShift) : null,
            tz: admin.tz,
            timeFormat: admin.timeFormat,
          }),
      });
    } else {
      await notifyPerson(client, config, swap.requester, {
        kind: 'swap_declined',
        shiftIds: swap.shiftIds,
        render: (ctx, prefs) =>
          swapDeclinedTemplate(ctx, {
            recipientName: swap.requester.name,
            takerName: swap.recipient.name,
            shift: emailShift(shift),
            returnShift: null,
            ...prefs,
          }),
      });
    }
    await audit(
      client,
      user.id,
      answer === 'accept' ? 'swap.accepted' : 'swap.declined',
      { type: 'swap', id: swapId },
      { requesterName: swap.requester.name, startTime: shift.startTime, endTime: shift.endTime },
    );
  });
  return getSwap(db, swapId);
}

/** The person who offered the shift takes the offer back. */
export async function cancelSwap(
  db: Db,
  config: Config,
  user: AuthUser,
  swapId: string,
): Promise<ShiftSwap> {
  await withTransaction(db, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('swaps'))");
    await settleOpenSwaps(client);
    const swap = await lockSwap(client, swapId);
    if (swap.requesterId !== user.id) throw notFound('Swap');
    assertStatus(swap.status, ['pending', 'accepted']);
    await client.query("UPDATE shift_swaps SET status = 'cancelled' WHERE id = $1", [swapId]);
    const view = await getSwap(client, swapId);
    await notifyPerson(client, config, swap.recipient, {
      kind: 'swap_cancelled',
      shiftIds: [view.shift.id],
      render: (ctx, prefs) =>
        swapCancelledTemplate(ctx, {
          recipientName: swap.recipient.name,
          requesterName: swap.requester.name,
          shift: emailShift(view.shift),
          returnShift: null,
          ...prefs,
        }),
    });
    await audit(
      client,
      user.id,
      'swap.cancelled',
      { type: 'swap', id: swapId },
      {
        recipientName: swap.recipient.name,
        startTime: view.shift.startTime,
        endTime: view.shift.endTime,
      },
    );
  });
  return getSwap(db, swapId);
}

/**
 * An admin approves (the shifts change hands in the published schedule right
 * away, already confirmed) or declines. Approving needs the coworker to have
 * accepted, the shifts to be as they were then, both people to be free, and
 * no unpublished edits to the shifts.
 */
export async function reviewSwap(
  db: Db,
  config: Config,
  admin: AuthUser,
  swapId: string,
  decision: 'approved' | 'denied',
  note: string | null,
): Promise<ShiftSwap> {
  await withTransaction(db, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('swaps'))");
    const { rows: about } = await client.query<{ shiftId: string; returnShiftId: string | null }>(
      'SELECT shift_id AS "shiftId", return_shift_id AS "returnShiftId" FROM shift_swaps WHERE id = $1',
      [swapId],
    );
    if (!about[0]) throw notFound('Swap');
    const ids = [about[0].shiftId, ...(about[0].returnShiftId ? [about[0].returnShiftId] : [])];
    // Locks in the builder's order: schedules, shifts, then the swap, then people.
    const shifts = await publishedShifts(client, ids, decision === 'approved');
    await settleOpenSwaps(client);
    const swap = await lockSwap(client, swapId);
    assertStatus(swap.status, decision === 'approved' ? ['accepted'] : ['pending', 'accepted']);
    const { requester, recipient } = swap;
    if (decision === 'approved') {
      const { shift, returnShift } = stillCurrent(swap, shifts);
      if ([shift, returnShift].some((s) => s && (s.deleted || s.changed))) {
        throw conflict(
          'One of the shifts has unpublished changes. Publish or discard them first.',
          'SWAP_UNPUBLISHED',
        );
      }
      assertSameTier(requester, recipient);
      if (!requester.active) throw badRequest(`${requester.name} is deactivated`);
      await assertBothFree(client, requester, recipient, shift, returnShift, { admin: true });
      const move = (id: string, to: string) =>
        client.query(
          `UPDATE shifts
              SET user_id = $2, published_user_id = $2, status = 'confirmed',
                  confirmed_at = now(), reminder_sent_at = NULL
            WHERE id = $1`,
          [id, to],
        );
      await move(shift.id, recipient.id);
      if (returnShift) await move(returnShift.id, requester.id);
    }
    await client.query(
      `UPDATE shift_swaps SET status = $2, reviewed_by = $3, reviewed_at = now(), review_note = $4
        WHERE id = $1`,
      [swapId, decision, admin.id, note],
    );
    const view = await getSwap(client, swapId);
    for (const [person, role, other] of [
      [requester, 'requester', recipient],
      [recipient, 'recipient', requester],
    ] as const) {
      if (person.id === admin.id) continue;
      await notifyPerson(client, config, person, {
        kind: 'swap_reviewed',
        shiftIds: swap.shiftIds,
        render: (ctx, prefs) =>
          swapReviewedTemplate(ctx, {
            recipientName: person.name,
            status: decision,
            role,
            otherName: other.name,
            reviewerName: admin.name,
            reviewNote: note,
            shift: emailShift(view.shift),
            returnShift: view.returnShift ? emailShift(view.returnShift) : null,
            ...prefs,
          }),
      });
    }
    await audit(
      client,
      admin.id,
      `swap.${decision}`,
      { type: 'swap', id: swapId },
      {
        requesterName: requester.name,
        recipientName: recipient.name,
        startTime: view.shift.startTime,
        endTime: view.shift.endTime,
        trade: Boolean(view.returnShift),
      },
    );
  });
  return getSwap(db, swapId);
}
