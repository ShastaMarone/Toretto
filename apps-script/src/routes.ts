// The API, path for path and field for field the same as the Express server's
// (server/src/routes), so the web app works unchanged. Sign-in, passwords,
// calendar feeds and the dev mailbox aren't part of the Google version.
import { HOLIDAY_REGIONS } from '@shared/holidays';
import type { HolidayRegion } from '@shared/types';
import { z } from 'zod';
import { badRequest } from '../../server/src/errors';
import {
  parse,
  zColor,
  zDate,
  zDateTime,
  zEmail,
  zId,
  zIdParam,
  zName,
  zText,
  zTimeOffWhen,
  zTimezone,
} from '../../server/src/lib/validation';
import { getSettings } from './core';
import { created, noContent, Router } from './http';
import * as admin from './services/admin';
import * as catalog from './services/catalog';
import * as member from './services/member';
import * as openShifts from './services/openShifts';
import * as people from './services/people';
import * as publish from './services/publish';
import * as schedules from './services/schedules';
import * as shifts from './services/shifts';
import * as swaps from './services/swaps';
import * as timeOff from './services/timeOff';

const RangeQuery = z.object({ from: zDate, to: zDate });

const ShiftBody = z.object({
  userId: zId,
  labelId: zId.nullable().default(null),
  startTime: zDateTime,
  endTime: zDateTime,
  notes: zText(500),
});

/** The same shift on several days (a repeating shift): up to 200 at once. */
const RepeatBody = z.object({
  userId: zId,
  labelId: zId.nullable().default(null),
  notes: zText(500),
  shifts: z
    .array(z.object({ startTime: zDateTime, endTime: zDateTime }))
    .min(1, 'Pick at least one day')
    .max(200, 'That repeats too many times (200 at most)'),
});

/** Edits send only what changed; a missing field means "leave it alone". */
const ShiftPatchBody = z.object({
  userId: zId.optional(),
  labelId: zId.nullable().optional(),
  startTime: zDateTime.optional(),
  endTime: zDateTime.optional(),
  notes: zText(500).optional(),
});

const NoteBody = z.object({ note: zText(500) });

/** An optional date range: both ends, or neither (meaning every date). */
function optionalRange(body: unknown): schedules.DateRange | null {
  const { from, to } = parse(
    z.object({ from: zDate.optional(), to: zDate.optional() }),
    body ?? {},
  );
  if (!from && !to) return null;
  if (!from || !to) throw badRequest('Send both `from` and `to`, or neither');
  return { from, to };
}

const id = (params: unknown) => parse(zIdParam, params).id;

export function createRouter(): Router {
  const r = new Router();

  // ---- Who's signed in, and their profile ---------------------------------
  r.get('/bootstrap', 'public', (_req, ctx) => people.bootstrap(ctx));
  r.patch('/me', 'user', (req, ctx) =>
    people.updateMe(
      ctx,
      parse(
        z.object({
          name: zName('Name', 100).optional(),
          timezone: zTimezone.nullable().optional(),
          timeFormat: z.enum(['12h', '24h']).nullable().optional(),
          notifyTimeOff: z.boolean().optional(),
          notifyConfirmations: z.boolean().optional(),
          notifySwaps: z.boolean().optional(),
          calendarSync: z.boolean().optional(),
        }),
        req.body,
      ),
    ),
  );

  // ---- My shifts and time off --------------------------------------------
  r.get('/my/shifts', 'user', (req, ctx) => {
    const { from, to } = parse(RangeQuery, req.query);
    return member.myShifts(ctx, ctx.user!, from, to);
  });
  r.post('/my/shifts/:id/confirm', 'user', (req, ctx) =>
    member.confirmShift(ctx, ctx.user!, id(req.params)),
  );
  r.post('/my/shifts/confirm', 'user', (req, ctx) => {
    const { shiftIds } = parse(
      z.object({ shiftIds: z.array(zId).min(1).max(200).optional() }),
      req.body,
    );
    return member.confirmShifts(ctx, ctx.user!, shiftIds);
  });
  r.get('/my/time-off', 'user', (_req, ctx) =>
    timeOff.listTimeOff(ctx, { userId: ctx.user!.id, status: 'all' }).map(timeOff.forMember),
  );
  r.post('/my/time-off', 'user', (req, ctx) => {
    const body = parse(z.object({ typeId: zId, ...zTimeOffWhen, note: zText(500) }), req.body);
    return created(timeOff.forMember(timeOff.requestTimeOff(ctx, ctx.user!, body)));
  });
  r.post('/my/time-off/:id/cancel', 'user', (req, ctx) =>
    timeOff.forMember(timeOff.cancelTimeOff(ctx, ctx.user!, id(req.params))),
  );
  r.get('/team/schedule', 'user', (req, ctx) => {
    const { from, to } = parse(RangeQuery, req.query);
    return member.teamSchedule(ctx, ctx.user!, from, to);
  });

  // ---- Swaps and open shifts (team members) -------------------------------
  r.get('/my/swaps', 'user', (_req, ctx) => swaps.listMySwaps(ctx, ctx.user!.id));
  r.get('/my/swaps/options', 'user', (req, ctx) => {
    const { shiftId } = parse(z.object({ shiftId: zId }), req.query);
    return swaps.swapOptions(ctx, ctx.user!, shiftId);
  });
  r.post('/my/swaps', 'user', (req, ctx) => {
    const body = parse(
      z.object({
        shiftId: zId,
        recipientId: zId,
        returnShiftId: zId.nullable().default(null),
        note: zText(500),
      }),
      req.body,
    );
    return created(swaps.requestSwap(ctx, ctx.user!, body));
  });
  for (const answer of ['accept', 'decline'] as const) {
    r.post(`/my/swaps/:id/${answer}`, 'user', (req, ctx) =>
      swaps.respondToSwap(ctx, ctx.user!, id(req.params), answer),
    );
  }
  r.post('/my/swaps/:id/cancel', 'user', (req, ctx) =>
    swaps.cancelSwap(ctx, ctx.user!, id(req.params)),
  );
  r.get('/my/open-shifts', 'user', (_req, ctx) => openShifts.openShiftsFor(ctx, ctx.user!));
  r.post('/my/open-shifts/:id/claim', 'user', (req, ctx) =>
    openShifts.claimOpenShift(ctx, ctx.user!, id(req.params)),
  );
  r.post('/my/open-shifts/:id/release', 'user', (req, ctx) =>
    openShifts.releaseOpenShift(ctx, ctx.user!, id(req.params)),
  );

  // ---- Tiers, teams, labels, time-off types --------------------------------
  r.get('/tiers', 'user', (_req, ctx) => catalog.listTiers(ctx));
  r.post('/tiers', 'admin', (req, ctx) =>
    created(
      catalog.createTier(
        ctx,
        parse(z.object({ name: zName('Tier name', 60), color: zColor }), req.body),
      ),
    ),
  );
  r.patch('/tiers/:id', 'admin', (req, ctx) =>
    catalog.updateTier(
      ctx,
      id(req.params),
      parse(
        z.object({
          name: zName('Tier name', 60).optional(),
          color: zColor.optional(),
          sortOrder: z.number().int().min(0).max(1000).optional(),
        }),
        req.body,
      ),
    ),
  );
  r.delete('/tiers/:id', 'admin', (req, ctx) => {
    catalog.deleteTier(ctx, id(req.params));
    return noContent();
  });
  r.get('/teams', 'user', (_req, ctx) => catalog.listTeams(ctx));
  r.post('/teams', 'admin', (req, ctx) =>
    created(catalog.createTeam(ctx, parse(z.object({ name: zName('Team name', 60) }), req.body))),
  );
  r.patch('/teams/:id', 'admin', (req, ctx) =>
    catalog.renameTeam(
      ctx,
      id(req.params),
      parse(z.object({ name: zName('Team name', 60) }), req.body),
    ),
  );
  r.delete('/teams/:id', 'admin', (req, ctx) => {
    catalog.deleteTeam(ctx, id(req.params));
    return noContent();
  });
  r.get('/labels', 'admin', (req, ctx) => {
    const { tierId } = parse(z.object({ tierId: zId.optional() }), req.query);
    return catalog.labelList(ctx, tierId);
  });
  r.post('/labels', 'admin', (req, ctx) =>
    created(
      catalog.createLabel(
        ctx,
        parse(
          z.object({ tierId: zId.nullable(), name: zName('Label name', 40), color: zColor }),
          req.body,
        ),
      ),
    ),
  );
  r.patch('/labels/:id', 'admin', (req, ctx) =>
    catalog.updateLabel(
      ctx,
      id(req.params),
      parse(
        z.object({
          name: zName('Label name', 40).optional(),
          color: zColor.optional(),
          tierId: zId.nullable().optional(),
        }),
        req.body,
      ),
    ),
  );
  r.delete('/labels/:id', 'admin', (req, ctx) => {
    catalog.deleteLabel(ctx, id(req.params));
    return noContent();
  });
  r.get('/time-off-types', 'user', (req, ctx) =>
    catalog.listTimeOffTypes(ctx, ctx.user!.role === 'admin' && req.query.all === '1'),
  );
  r.post('/time-off-types', 'admin', (req, ctx) =>
    created(
      catalog.createTimeOffType(
        ctx,
        parse(
          z.object({ name: zName('Name', 40), color: zColor, paid: z.boolean().default(true) }),
          req.body,
        ),
      ),
    ),
  );
  r.patch('/time-off-types/:id', 'admin', (req, ctx) =>
    catalog.updateTimeOffType(
      ctx,
      id(req.params),
      parse(
        z.object({
          name: zName('Name', 40).optional(),
          color: zColor.optional(),
          paid: z.boolean().optional(),
          archived: z.boolean().optional(),
        }),
        req.body,
      ),
    ),
  );
  r.delete('/time-off-types/:id', 'admin', (req, ctx) => {
    catalog.deleteTimeOffType(ctx, id(req.params));
    return noContent();
  });

  // ---- People --------------------------------------------------------------
  r.get('/users', 'admin', (_req, ctx) => people.listPeople(ctx));
  r.post('/users', 'admin', (req, ctx) =>
    created(
      people.invitePerson(
        ctx,
        parse(
          z.object({
            name: zName('Name', 100),
            email: zEmail,
            role: z.enum(['admin', 'member']).default('member'),
            tierId: zId.nullable().default(null),
            teamId: zId.nullable().default(null),
          }),
          req.body,
        ),
      ),
    ),
  );
  r.patch('/users/:id', 'admin', (req, ctx) =>
    people.updatePerson(
      ctx,
      id(req.params),
      parse(
        z.object({
          name: zName('Name', 100).optional(),
          email: zEmail.optional(),
          role: z.enum(['admin', 'member']).optional(),
          tierId: zId.nullable().optional(),
          teamId: zId.nullable().optional(),
          timezone: zTimezone.nullable().optional(),
          active: z.boolean().optional(),
        }),
        req.body,
      ),
    ),
  );
  r.post('/users/:id/resend-invite', 'admin', (req, ctx) =>
    people.resendInvite(ctx, id(req.params)),
  );
  r.delete('/users/:id', 'admin', (req, ctx) => {
    people.deletePerson(ctx, id(req.params));
    return noContent();
  });

  // ---- Schedules and shifts ------------------------------------------------
  r.get('/schedules', 'admin', (_req, ctx) => schedules.listSchedules(ctx));
  r.post('/schedules', 'admin', (req, ctx) =>
    created(
      schedules.createSchedule(
        ctx,
        ctx.user!,
        parse(z.object({ name: zName('Name', 80) }), req.body),
      ),
    ),
  );
  r.get('/schedules/:id', 'admin', (req, ctx) =>
    schedules.getScheduleRange(ctx, id(req.params), parse(RangeQuery, req.query)),
  );
  r.patch('/schedules/:id', 'admin', (req, ctx) => {
    const { name } = parse(z.object({ name: zName('Name', 80) }), req.body);
    return schedules.renameSchedule(ctx, ctx.user!, id(req.params), name);
  });
  r.delete('/schedules/:id', 'admin', (req, ctx) =>
    publish.deleteSchedule(ctx, id(req.params), ctx.user!),
  );
  r.post('/schedules/:id/publish', 'admin', (req, ctx) =>
    publish.publishSchedule(ctx, id(req.params), ctx.user!, optionalRange(req.body)),
  );
  r.post('/schedules/:id/discard-changes', 'admin', (req, ctx) => {
    const scheduleId = id(req.params);
    const result = publish.discardChanges(ctx, scheduleId, ctx.user!, optionalRange(req.body));
    return { ...result, schedule: schedules.getScheduleSummary(ctx, scheduleId) };
  });
  r.post('/schedules/:id/copy', 'admin', (req, ctx) =>
    schedules.copyShifts(
      ctx,
      ctx.user!,
      id(req.params),
      parse(RangeQuery.extend({ targetStart: zDate }), req.body),
    ),
  );
  r.post('/schedules/:id/shifts', 'admin', (req, ctx) =>
    created(shifts.createShift(ctx, ctx.user!, id(req.params), parse(ShiftBody, req.body))),
  );
  r.post('/schedules/:id/shifts/bulk', 'admin', (req, ctx) =>
    created(shifts.createShifts(ctx, ctx.user!, id(req.params), parse(RepeatBody, req.body))),
  );
  r.patch('/shifts/:id', 'admin', (req, ctx) =>
    shifts.updateShift(ctx, id(req.params), parse(ShiftPatchBody, req.body)),
  );
  r.delete('/shifts/:id', 'admin', (req, ctx) => shifts.deleteShift(ctx, id(req.params)));
  r.post('/shifts/:id/restore', 'admin', (req, ctx) => shifts.restoreShift(ctx, id(req.params)));

  // ---- Time off (admins) -----------------------------------------------------
  r.get('/time-off', 'admin', (req, ctx) =>
    timeOff.listTimeOff(
      ctx,
      parse(
        z.object({
          status: z.enum(['pending', 'approved', 'denied', 'cancelled', 'all']).default('all'),
          from: zDate.optional(),
          to: zDate.optional(),
          userId: zId.optional(),
        }),
        req.query,
      ),
    ),
  );
  r.post('/time-off', 'admin', (req, ctx) => {
    const { userId, ...input } = parse(
      z.object({ userId: zId, typeId: zId, ...zTimeOffWhen, note: zText(500) }),
      req.body,
    );
    return created(timeOff.addTimeOffForPerson(ctx, ctx.user!, userId, input));
  });
  for (const [path, decision] of [
    ['approve', 'approved'],
    ['deny', 'denied'],
  ] as const) {
    r.post(`/time-off/:id/${path}`, 'admin', (req, ctx) =>
      timeOff.reviewTimeOff(
        ctx,
        ctx.user!,
        id(req.params),
        decision,
        parse(NoteBody, req.body).note,
      ),
    );
    r.post(`/swaps/:id/${path}`, 'admin', (req, ctx) =>
      swaps.reviewSwap(ctx, ctx.user!, id(req.params), decision, parse(NoteBody, req.body).note),
    );
    r.post(`/open-shifts/:id/${path}`, 'admin', (req, ctx) =>
      openShifts.reviewOpenShift(
        ctx,
        ctx.user!,
        id(req.params),
        decision,
        parse(NoteBody, req.body).note,
      ),
    );
  }

  // ---- Swaps and open shifts (admins) ----------------------------------------
  r.get('/swaps', 'admin', (_req, ctx) => swaps.listSwaps(ctx));
  r.get('/open-shifts', 'admin', (_req, ctx) => openShifts.listOpenShifts(ctx));
  r.post('/open-shifts', 'admin', (req, ctx) =>
    created(
      openShifts.postOpenShift(
        ctx,
        ctx.user!,
        parse(
          z.object({
            scheduleId: zId.nullable().default(null),
            tierId: zId,
            labelId: zId.nullable().default(null),
            startTime: zDateTime,
            endTime: zDateTime,
            notes: zText(500),
          }),
          req.body,
        ),
      ),
    ),
  );
  r.post('/open-shifts/:id/cancel', 'admin', (req, ctx) =>
    openShifts.cancelOpenShift(ctx, ctx.user!, id(req.params)),
  );

  // ---- Dashboard, activity, email log, settings ----------------------------
  r.get('/admin/overview', 'admin', (_req, ctx) => admin.overview(ctx));
  r.get('/admin/activity', 'admin', (req, ctx) => {
    const { limit, before } = parse(
      z.object({
        limit: z.coerce.number().int().min(1).max(200).default(50),
        before: z.coerce.number().int().positive().optional(),
      }),
      req.query,
    );
    return admin.listActivity(ctx, limit, before);
  });
  r.get('/admin/notifications', 'admin', (req, ctx) => {
    const { limit, status } = parse(
      z.object({
        limit: z.coerce.number().int().min(1).max(200).default(100),
        status: z.enum(['queued', 'sending', 'sent', 'failed']).optional(),
      }),
      req.query,
    );
    return admin.listNotifications(ctx, limit, status);
  });
  r.get('/admin/notifications/:id', 'admin', (req, ctx) =>
    admin.getNotification(ctx, id(req.params)),
  );
  r.post('/admin/notifications/:id/retry', 'admin', (req, ctx) => {
    admin.retryNotification(ctx, id(req.params));
    return noContent();
  });
  r.get('/admin/settings', 'admin', (_req, ctx) => getSettings(ctx.db));
  r.patch('/admin/settings', 'admin', (req, ctx) =>
    admin.updateSettings(
      ctx,
      parse(
        z.object({
          orgName: zName('Organization name', 80).optional(),
          timezone: zTimezone.optional(),
          weekStartsOn: z.union([z.literal(0), z.literal(1)]).optional(),
          reminderHours: z.number().int().min(0).max(336).optional(),
          selfSignup: z.boolean().optional(),
          allowedDomains: z
            .array(
              z
                .string()
                .trim()
                .toLowerCase()
                .transform((d) => d.replace(/^@/, '')),
            )
            .max(20)
            .optional(),
          holidayRegion: z
            .enum(HOLIDAY_REGIONS.map((h) => h.value) as [HolidayRegion, ...HolidayRegion[]])
            .optional(),
          timeFormat: z.enum(['12h', '24h']).optional(),
          emailRetentionDays: z.number().int().min(1).max(3650).nullable().optional(),
          overtimeDailyHours: z.number().positive().max(24).nullable().optional(),
          overtimeWeeklyHours: z.number().positive().max(168).nullable().optional(),
        }),
        req.body,
      ),
    ),
  );

  return r;
}
