import { describe, expect, it } from 'vitest';
import { html, raw } from '../src/email/html';
import {
  firstName,
  scheduleTemplate,
  shiftsConfirmedTemplate,
  timeOffRequestedTemplate,
  timeOffReviewedTemplate,
} from '../src/email/templates';
import { parseAddress } from '../src/email/transport';
import { shiftOn } from './helpers';

const ctx = { orgName: 'Acme <Support>', appUrl: 'https://schedule.example.com' };

describe('email html', () => {
  it('escapes interpolated values but not nested templates', () => {
    const name = '<img src=x onerror=alert(1)>';
    const out = html`<p>${name}</p>${html`<b>${'&'}</b>`}${raw('<br>')}`.value;
    expect(out).toBe('<p>&lt;img src=x onerror=alert(1)&gt;</p><b>&amp;</b><br>');
  });

  it('escapes user content in schedule emails', () => {
    const shift = {
      id: 'shift-1',
      ...shiftOn('2026-10-06'),
      labelName: '<script>x</script>',
      color: 'red;background:url(evil)',
      notes: 'Use the <back> door',
      needsConfirmation: true,
    };
    const email = scheduleTemplate(ctx, {
      recipientName: 'Jo <b>Bold</b>',
      tz: 'America/Toronto',
      timeFormat: '12h',
      scheduleName: 'Weekend "A"',
      startDate: '2026-10-05',
      endDate: '2026-10-11',
      added: [shift],
      updated: [],
      removed: [],
    });
    expect(email.html).not.toContain('<script>');
    expect(email.html).toContain('&lt;script&gt;');
    expect(email.html).toContain('Use the &lt;back&gt; door');
    expect(email.html).toContain('on the Weekend &quot;A&quot;');
    expect(email.html).not.toContain('url(evil)'); // invalid colors fall back
    expect(email.html).toContain('Acme &lt;Support&gt;');
    expect(email.html).toContain('https://schedule.example.com/confirm-shift/shift-1');
    expect(email.html).toContain('https://schedule.example.com/confirm-shifts?ids=shift-1');
    expect(email.text).toContain('Hi Jo,');
    expect(email.text).toContain('Tue, Oct 6 · 9:00 AM – 5:00 PM');
    expect(email.text).toContain('Times are shown in EDT (America/Toronto).');
    expect(email.subject).toBe('Your schedule for Oct 5 – 11, 2026');
  });

  it('writes times in 12- or 24-hour format for each reader', () => {
    const shift = {
      id: 'shift-1',
      ...shiftOn('2026-10-06'),
      labelName: null,
      color: null,
      notes: null,
      needsConfirmation: true,
    };
    const input = {
      recipientName: 'Jo',
      tz: 'America/Toronto',
      scheduleName: null,
      startDate: '2026-10-06',
      endDate: '2026-10-06',
      added: [shift],
      updated: [],
      removed: [],
    };
    const email = scheduleTemplate(ctx, { ...input, timeFormat: '24h' });
    expect(email.text).toContain('Tue, Oct 6 · 09:00 – 17:00');
    expect(email.html).toContain('Tue, Oct 6 · 09:00 – 17:00');
    expect(scheduleTemplate(ctx, { ...input, timeFormat: '12h' }).text).toContain(
      'Tue, Oct 6 · 9:00 AM – 5:00 PM',
    );
  });

  it('tells admins who confirmed which shifts', () => {
    const email = shiftsConfirmedTemplate(ctx, {
      recipientName: 'Robin Admin',
      personName: 'Priya <P>',
      tz: 'America/Toronto',
      timeFormat: '12h',
      shifts: [
        {
          id: 's1',
          ...shiftOn('2026-10-06'),
          labelName: 'Chat Queue',
          color: '#2563eb',
          notes: null,
          needsConfirmation: false,
        },
      ],
    });
    expect(email.subject).toBe('Priya <P> confirmed their shift on Tue, Oct 6');
    expect(email.html).toContain('Priya &lt;P&gt; confirmed this shift');
    expect(email.html).not.toContain('confirm-shift/s1');
    expect(email.text).toContain('Tue, Oct 6 · 9:00 AM – 5:00 PM (Chat Queue)');
    expect(email.text).toContain('https://schedule.example.com/profile');
  });

  it('keeps subjects on one line', () => {
    const email = timeOffRequestedTemplate(ctx, {
      recipientName: 'Admin',
      requesterName: 'Line\nBreak',
      typeName: 'Vacation',
      span: { startDate: '2026-10-05', endDate: '2026-10-05', startTime: null, endTime: null },
      tz: 'America/Toronto',
      timeFormat: '12h',
      note: null,
      conflicts: 0,
    });
    expect(email.subject).not.toMatch(/[\r\n]/);
    expect(email.text).toContain('(1 day)');
  });

  it("gives the hours of time off for part of a day, in each reader's zone and format", () => {
    const span = {
      startDate: '2026-10-06',
      endDate: '2026-10-06',
      startTime: '2026-10-06T17:00:00.000Z',
      endTime: '2026-10-06T19:30:00.000Z',
    };
    const requested = timeOffRequestedTemplate(ctx, {
      recipientName: 'Admin',
      requesterName: 'Priya Patel',
      typeName: 'Personal Day',
      span,
      tz: 'America/Toronto',
      timeFormat: '12h',
      note: 'Dentist',
      conflicts: 1,
    });
    expect(requested.subject).toBe(
      'Time-off request: Priya Patel · Personal Day, Tue, Oct 6 · 1:00 PM – 3:30 PM',
    );
    expect(requested.text).toContain('for Tue, Oct 6 · 1:00 PM – 3:30 PM (2h 30m).');
    const reviewed = timeOffReviewedTemplate(ctx, {
      recipientName: 'Priya Patel',
      status: 'approved',
      typeName: 'Personal Day',
      span,
      tz: 'America/Vancouver',
      timeFormat: '24h',
      reviewerName: 'Robin',
      reviewNote: null,
    });
    expect(reviewed.subject).toBe(
      'Your time off was approved: Personal Day, Tue, Oct 6 · 10:00 – 12:30',
    );
  });
});

describe('helpers', () => {
  it('parses from addresses', () => {
    expect(parseAddress('Toretto <no-reply@example.com>')).toEqual({
      name: 'Toretto',
      email: 'no-reply@example.com',
    });
    expect(parseAddress('"Ops Team" <ops@example.com>')).toEqual({
      name: 'Ops Team',
      email: 'ops@example.com',
    });
    expect(parseAddress('plain@example.com')).toEqual({ email: 'plain@example.com' });
  });

  it('greets by first name', () => {
    expect(firstName('  Priya   Patel ')).toBe('Priya');
    expect(firstName('Cher')).toBe('Cher');
  });
});
