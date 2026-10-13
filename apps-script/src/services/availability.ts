import { ms, tables, type Ctx } from '../core';
import { approvedTimeOffBetween } from './timeOff';

/** Something that has someone busy: a shift (draft or published) or approved time off. */
export interface Busy {
  userId: string;
  /** For shifts, so a swap can leave out the shifts that are changing hands. */
  shiftId: string | null;
  from: string;
  to: string;
  kind: 'shift' | 'time_off';
}

/**
 * What these people have on between from and to. Drafts (unpublished
 * changes) are only for admins: telling a team member "Working then" about a
 * shift they can't see yet would give it away.
 */
export function busyBetween(
  ctx: Ctx,
  userIds: string[],
  from: string,
  to: string,
  { drafts }: { drafts: boolean },
): Busy[] {
  const ids = new Set(userIds);
  const [start, end] = [ms(from), ms(to)];
  const busy: Busy[] = [];
  for (const s of tables(ctx.db).shifts.all()) {
    if (
      drafts &&
      ids.has(s.userId) &&
      !s.deletedAt &&
      ms(s.startTime) < end &&
      ms(s.endTime) > start
    ) {
      busy.push({
        userId: s.userId,
        shiftId: s.id,
        from: s.startTime,
        to: s.endTime,
        kind: 'shift',
      });
    }
    if (
      s.publishedAt &&
      s.publishedUserId &&
      ids.has(s.publishedUserId) &&
      ms(s.publishedStartTime!) < end &&
      ms(s.publishedEndTime!) > start
    ) {
      busy.push({
        userId: s.publishedUserId,
        shiftId: s.id,
        from: s.publishedStartTime!,
        to: s.publishedEndTime!,
        kind: 'shift',
      });
    }
  }
  for (const span of approvedTimeOffBetween(ctx, userIds, from, to)) {
    busy.push({
      userId: span.userId,
      shiftId: null,
      from: span.from,
      to: span.to,
      kind: 'time_off',
    });
  }
  return busy;
}

/** Why someone can't work from..to ("Working then", "Off then"), or null if they can. */
export function busyReason(
  busy: Busy[],
  userId: string,
  from: string,
  to: string,
  ignoreShiftIds: string[] = [],
): string | null {
  const start = Date.parse(from);
  const end = Date.parse(to);
  const clashes = busy.filter(
    (b) =>
      b.userId === userId &&
      !(b.shiftId && ignoreShiftIds.includes(b.shiftId)) &&
      Date.parse(b.from) < end &&
      Date.parse(b.to) > start,
  );
  if (clashes.some((b) => b.kind === 'shift')) return 'Working then';
  return clashes.length ? 'Off then' : null;
}
