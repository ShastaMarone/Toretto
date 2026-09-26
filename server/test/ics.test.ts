import { describe, expect, it } from 'vitest';
import { fold, icsCalendar, text } from '../src/lib/ics';

const unfold = (ics: string) => ics.replace(/\r\n /g, '');

describe('icsCalendar', () => {
  const ics = icsCalendar({
    name: 'Night Crew shifts',
    now: new Date('2026-10-01T12:34:56.789Z'),
    events: [
      {
        uid: 'a@toretto',
        summary: 'Chat Queue shift',
        description: 'Notes: bring a headset\nView in Toretto: https://example.com/my-schedule',
        when: { start: '2026-10-12T13:00:00.000Z', end: '2026-10-12T21:30:00.000Z' },
      },
      {
        uid: 'b@toretto',
        summary: 'Time off: Vacation',
        when: { firstDay: '2026-12-30', lastDay: '2027-01-01' },
        free: true,
      },
    ],
  });

  it('writes a calendar with CRLF line endings', () => {
    expect(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n')).toBe(true);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    expect(ics).toContain('\r\nX-WR-CALNAME:Night Crew shifts\r\n');
    expect(ics).toContain('\r\nMETHOD:PUBLISH\r\n');
  });

  it('writes timed events in UTC', () => {
    const lines = unfold(ics).split('\r\n');
    const start = lines.indexOf('UID:a@toretto');
    expect(lines.slice(start, lines.indexOf('END:VEVENT', start))).toEqual([
      'UID:a@toretto',
      'DTSTAMP:20261001T123456Z',
      'DTSTART:20261012T130000Z',
      'DTEND:20261012T213000Z',
      'SUMMARY:Chat Queue shift',
      'DESCRIPTION:Notes: bring a headset\\nView in Toretto: https://example.com/my-schedule',
    ]);
  });

  it('writes whole days with the day after the last one as the end', () => {
    const lines = unfold(ics).split('\r\n');
    const start = lines.indexOf('UID:b@toretto');
    expect(lines.slice(start, lines.indexOf('END:VEVENT', start))).toEqual([
      'UID:b@toretto',
      'DTSTAMP:20261001T123456Z',
      'DTSTART;VALUE=DATE:20261230',
      'DTEND;VALUE=DATE:20270102',
      'SUMMARY:Time off: Vacation',
      'TRANSP:TRANSPARENT',
    ]);
  });
});

describe('text', () => {
  it('escapes backslashes, semicolons, commas and line breaks', () => {
    expect(text('a\\b;c,d\ne\r\nf\rg')).toBe('a\\\\b\\;c\\,d\\ne\\nf\\ng');
  });

  it('keeps tabs and drops other control characters', () => {
    expect(text('one\ttwo\u0000\u0007\u001b\u007fthree: "four"')).toBe('one\ttwothree: "four"');
  });
});

describe('fold', () => {
  const bytes = (s: string) => Buffer.byteLength(s);

  it('leaves short lines alone', () => {
    const line = `SUMMARY:${'x'.repeat(67)}`;
    expect(bytes(line)).toBe(75);
    expect(fold(line)).toBe(line);
  });

  it('breaks long lines at 75 bytes, continuing after a space', () => {
    const line = `DESCRIPTION:${'abcdefghij'.repeat(20)}`;
    const parts = fold(line).split('\r\n');
    expect(parts.length).toBeGreaterThan(2);
    expect(parts.every((p) => bytes(p) <= 75)).toBe(true);
    expect(parts.slice(1).every((p) => p.startsWith(' '))).toBe(true);
    expect(bytes(parts[0]!)).toBe(75);
    expect(unfold(fold(line))).toBe(line);
  });

  it('never splits a character that takes several bytes', () => {
    const line = `SUMMARY:${'Café ☕ 🎉 é'.repeat(12)}`;
    const parts = fold(line).split('\r\n');
    expect(parts.every((p) => bytes(p) <= 75)).toBe(true);
    // Each part is whole characters: it survives a round trip through UTF-8.
    expect(parts.every((p) => Buffer.from(p, 'utf8').toString('utf8') === p)).toBe(true);
    expect(unfold(fold(line))).toBe(line);
  });
});
