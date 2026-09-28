// Tiers, teams, labels and time-off types: the admin-defined building blocks.
import type { Label, Team, Tier, TimeOffType } from '@shared/types';
import { conflict, notFound } from '../../../server/src/errors';
import { audit, byName, compare, tables, type Ctx } from '../core';
import type { LabelRow, TimeOffTypeRow } from '../db/schema';

/** What Postgres's unique indexes said. */
const nameTaken = () => conflict('That name or email is already in use', 'ALREADY_EXISTS');

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// ---- Tiers -----------------------------------------------------------------

function toTier(ctx: Ctx, id: string): Tier {
  const t = tables(ctx.db);
  const tier = t.tiers.get(id);
  if (!tier) throw notFound('Tier');
  return {
    id: tier.id,
    name: tier.name,
    color: tier.color,
    sortOrder: tier.sortOrder,
    memberCount: t.users.where((u) => u.tierId === id && !u.deactivatedAt).length,
  };
}

export function listTiers(ctx: Ctx): Tier[] {
  return tables(ctx.db)
    .tiers.all()
    .sort((a, b) => a.sortOrder - b.sortOrder || byName(a, b))
    .map((tier) => toTier(ctx, tier.id));
}

export function createTier(ctx: Ctx, body: { name: string; color: string }): Tier {
  const t = tables(ctx.db);
  if (t.tiers.find((x) => sameName(x.name, body.name))) throw nameTaken();
  const sortOrder = Math.max(0, ...t.tiers.all().map((x) => x.sortOrder)) + 1;
  const row = t.tiers.insert({ ...body, sortOrder });
  audit(ctx, ctx.user!.id, 'tier.created', { type: 'tier', id: row.id }, { name: body.name });
  return toTier(ctx, row.id);
}

export function updateTier(
  ctx: Ctx,
  id: string,
  body: { name?: string; color?: string; sortOrder?: number },
): Tier {
  const t = tables(ctx.db);
  if (!t.tiers.get(id)) throw notFound('Tier');
  if (body.name && t.tiers.find((x) => x.id !== id && sameName(x.name, body.name!))) {
    throw nameTaken();
  }
  t.tiers.update(id, body);
  audit(ctx, ctx.user!.id, 'tier.updated', { type: 'tier', id }, body);
  return toTier(ctx, id);
}

export function deleteTier(ctx: Ctx, id: string): void {
  const t = tables(ctx.db);
  if (t.users.find((u) => u.tierId === id && !u.deactivatedAt)) {
    throw conflict(
      'People are still in this tier. Move them to another tier on the People page first, or rename the tier instead.',
      'TIER_HAS_PEOPLE',
    );
  }
  const labelIds = new Set(t.labels.where((l) => l.tierId === id).map((l) => l.id));
  // Deleting the tier deletes its labels, which would silently vanish from shifts.
  if (
    t.shifts.find((s) => labelIds.has(s.labelId ?? '') || labelIds.has(s.publishedLabelId ?? ''))
  ) {
    throw conflict(
      "This tier's labels are used on shifts. Rename the tier instead, or delete those labels first.",
      'TIER_LABELS_IN_USE',
    );
  }
  const tier = t.tiers.get(id);
  if (!tier) throw notFound('Tier');
  for (const u of t.users.where((u) => u.tierId === id)) t.users.update(u.id, { tierId: null });
  for (const labelId of labelIds) removeLabel(ctx, labelId);
  for (const o of t.openShifts.where((o) => o.tierId === id)) t.openShifts.delete(o.id);
  t.tiers.delete(id);
  audit(ctx, ctx.user!.id, 'tier.deleted', { type: 'tier', id }, { name: tier.name });
}

// ---- Teams -----------------------------------------------------------------

function toTeam(ctx: Ctx, id: string): Team {
  const t = tables(ctx.db);
  const team = t.teams.get(id);
  if (!team) throw notFound('Team');
  return {
    id: team.id,
    name: team.name,
    memberCount: t.users.where((u) => u.teamId === id && !u.deactivatedAt).length,
  };
}

export function listTeams(ctx: Ctx): Team[] {
  return tables(ctx.db)
    .teams.all()
    .sort(byName)
    .map((team) => toTeam(ctx, team.id));
}

export function createTeam(ctx: Ctx, body: { name: string }): Team {
  const t = tables(ctx.db);
  if (t.teams.find((x) => sameName(x.name, body.name))) throw nameTaken();
  const row = t.teams.insert(body);
  audit(ctx, ctx.user!.id, 'team.created', { type: 'team', id: row.id }, { name: body.name });
  return toTeam(ctx, row.id);
}

export function renameTeam(ctx: Ctx, id: string, body: { name: string }): Team {
  const t = tables(ctx.db);
  if (!t.teams.get(id)) throw notFound('Team');
  if (t.teams.find((x) => x.id !== id && sameName(x.name, body.name))) throw nameTaken();
  t.teams.update(id, body);
  audit(ctx, ctx.user!.id, 'team.updated', { type: 'team', id }, { name: body.name });
  return toTeam(ctx, id);
}

export function deleteTeam(ctx: Ctx, id: string): void {
  const t = tables(ctx.db);
  const team = t.teams.get(id);
  if (!team) throw notFound('Team');
  for (const u of t.users.where((u) => u.teamId === id)) t.users.update(u.id, { teamId: null });
  t.teams.delete(id);
  audit(ctx, ctx.user!.id, 'team.deleted', { type: 'team', id }, { name: team.name });
}

// ---- Labels ----------------------------------------------------------------

function toLabel(ctx: Ctx, l: LabelRow): Label {
  return {
    id: l.id,
    tierId: l.tierId,
    name: l.name,
    color: l.color,
    shiftCount: tables(ctx.db).shifts.where((s) => s.labelId === l.id && !s.deletedAt).length,
  };
}

/** Every label (or those for one tier, plus everyone's): everyone's first, then by name. */
export function labelList(ctx: Ctx, tierId?: string): Label[] {
  return tables(ctx.db)
    .labels.where((l) => !tierId || l.tierId === tierId || l.tierId === null)
    .sort((a, b) => Number(a.tierId !== null) - Number(b.tierId !== null) || byName(a, b))
    .map((l) => toLabel(ctx, l));
}

function assertLabelNameFree(ctx: Ctx, tierId: string | null, name: string, exceptId?: string) {
  const clash = tables(ctx.db).labels.find(
    (l) => l.id !== exceptId && l.tierId === tierId && sameName(l.name, name),
  );
  if (clash) throw nameTaken();
}

export function createLabel(
  ctx: Ctx,
  body: { tierId: string | null; name: string; color: string },
): Label {
  const t = tables(ctx.db);
  if (body.tierId && !t.tiers.get(body.tierId)) throw notFound('Tier');
  assertLabelNameFree(ctx, body.tierId, body.name);
  const row = t.labels.insert(body);
  audit(ctx, ctx.user!.id, 'label.created', { type: 'label', id: row.id }, { name: body.name });
  return toLabel(ctx, row);
}

export function updateLabel(
  ctx: Ctx,
  id: string,
  body: { name?: string; color?: string; tierId?: string | null },
): Label {
  const t = tables(ctx.db);
  const label = t.labels.get(id);
  if (!label) throw notFound('Label');
  if (body.tierId && !t.tiers.get(body.tierId)) throw notFound('Tier');
  assertLabelNameFree(
    ctx,
    body.tierId !== undefined ? body.tierId : label.tierId,
    body.name ?? label.name,
    id,
  );
  const row = t.labels.update(id, body);
  audit(ctx, ctx.user!.id, 'label.updated', { type: 'label', id }, body);
  return toLabel(ctx, row);
}

/** Delete a label: shifts and open shifts that had it just have none. */
function removeLabel(ctx: Ctx, id: string): void {
  const t = tables(ctx.db);
  for (const s of t.shifts.where((s) => s.labelId === id || s.publishedLabelId === id)) {
    t.shifts.update(s.id, {
      ...(s.labelId === id ? { labelId: null } : {}),
      ...(s.publishedLabelId === id ? { publishedLabelId: null } : {}),
    });
  }
  for (const o of t.openShifts.where((o) => o.labelId === id)) {
    t.openShifts.update(o.id, { labelId: null });
  }
  t.labels.delete(id);
}

export function deleteLabel(ctx: Ctx, id: string): void {
  const label = tables(ctx.db).labels.get(id);
  if (!label) throw notFound('Label');
  removeLabel(ctx, id);
  audit(ctx, ctx.user!.id, 'label.deleted', { type: 'label', id }, { name: label.name });
}

// ---- Time-off types --------------------------------------------------------

const toType = (r: TimeOffTypeRow): TimeOffType => ({
  id: r.id,
  name: r.name,
  color: r.color,
  paid: r.paid,
  archived: r.archivedAt !== null,
  sortOrder: r.sortOrder,
});

export function listTimeOffTypes(ctx: Ctx, includeArchived: boolean): TimeOffType[] {
  return tables(ctx.db)
    .timeOffTypes.where((r) => includeArchived || !r.archivedAt)
    .sort(
      (a, b) => a.sortOrder - b.sortOrder || compare(a.name.toLowerCase(), b.name.toLowerCase()),
    )
    .map(toType);
}

export function createTimeOffType(
  ctx: Ctx,
  body: { name: string; color: string; paid: boolean },
): TimeOffType {
  const t = tables(ctx.db);
  if (t.timeOffTypes.find((x) => sameName(x.name, body.name))) throw nameTaken();
  const sortOrder = Math.max(0, ...t.timeOffTypes.all().map((x) => x.sortOrder)) + 1;
  const row = t.timeOffTypes.insert({ ...body, sortOrder });
  audit(
    ctx,
    ctx.user!.id,
    'time_off_type.created',
    { type: 'time_off_type', id: row.id },
    { name: body.name },
  );
  return toType(row);
}

export function updateTimeOffType(
  ctx: Ctx,
  id: string,
  body: { name?: string; color?: string; paid?: boolean; archived?: boolean },
): TimeOffType {
  const t = tables(ctx.db);
  const current = t.timeOffTypes.get(id);
  if (!current) throw notFound('Time-off type');
  if (body.name && t.timeOffTypes.find((x) => x.id !== id && sameName(x.name, body.name!))) {
    throw nameTaken();
  }
  const { archived, ...rest } = body;
  const row = t.timeOffTypes.update(id, {
    ...rest,
    ...(archived === undefined
      ? {}
      : { archivedAt: archived ? (current.archivedAt ?? ctx.now) : null }),
  });
  audit(ctx, ctx.user!.id, 'time_off_type.updated', { type: 'time_off_type', id }, body);
  return toType(row);
}

export function deleteTimeOffType(ctx: Ctx, id: string): void {
  const t = tables(ctx.db);
  if (t.timeOff.find((r) => r.typeId === id)) {
    throw conflict('This type is used by existing requests. Archive it instead.', 'TYPE_IN_USE');
  }
  const type = t.timeOffTypes.get(id);
  if (!type) throw notFound('Time-off type');
  t.timeOffTypes.delete(id);
  audit(
    ctx,
    ctx.user!.id,
    'time_off_type.deleted',
    { type: 'time_off_type', id },
    { name: type.name },
  );
}
