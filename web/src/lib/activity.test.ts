import { shiftTimesFromLocal } from '@shared/time';
import type { AuditEntry } from '@shared/types';
import { describe, expect, it } from 'vitest';
import { describeActivity } from './activity';

const TZ = 'America/Toronto';
const entry = (action: string, details: Record<string, unknown>): AuditEntry => ({
  id: 1,
  actorId: null,
  actorName: 'Alex',
  action,
  entityType: 'schedule',
  entityId: null,
  details,
  createdAt: '2026-09-26T12:00:00Z',
});

describe('describeActivity', () => {
  it('describes publishing a date range or everything', () => {
    const counts = { title: 'Main schedule', added: 3, updated: 1, removed: 0, emails: 2 };
    expect(
      describeActivity(
        entry('schedule.published', { ...counts, range: 'Sep 28 – Oct 4, 2026' }),
        TZ,
      ),
    ).toBe('published Sep 28 – Oct 4, 2026 on Main schedule — 3 new, 1 changed, 2 emails sent');
    expect(
      describeActivity(entry('schedule.published', { ...counts, range: 'all dates' }), TZ),
    ).toBe('published every change on Main schedule — 3 new, 1 changed, 2 emails sent');
  });

  it('still reads entries from before schedules were open-ended', () => {
    expect(
      describeActivity(
        entry('schedule.published', {
          title: 'Tier 1 · Oct 5',
          firstPublish: true,
          added: 4,
          emails: 4,
        }),
        TZ,
      ),
    ).toBe('published Tier 1 · Oct 5 — 4 new, 4 emails sent');
    const { startTime, endTime } = shiftTimesFromLocal('2026-10-05', '09:00', '17:00', TZ);
    expect(
      describeActivity(entry('shift.confirmed', { tierName: 'Tier 1', startTime, endTime }), TZ),
    ).toMatch(/^confirmed their Tier 1 shift /);
    expect(describeActivity(entry('shift.confirmed', { startTime, endTime }), TZ)).toMatch(
      /^confirmed their shift /,
    );
  });

  it('describes renaming and copying', () => {
    expect(
      describeActivity(entry('schedule.renamed', { title: 'Holidays', previous: 'Extra' }), TZ),
    ).toBe('renamed Extra to Holidays');
    expect(
      describeActivity(
        entry('schedule.copied', {
          title: 'Main schedule',
          from: '2026-09-28',
          to: '2026-10-04',
          targetStart: '2026-10-05',
          copied: 12,
        }),
        TZ,
      ),
    ).toBe('copied 12 shifts on Main schedule from Sep 28 – Oct 4, 2026 into Oct 5 – 11, 2026');
  });
});
