import { describe, expect, it } from 'vitest';
import { html, raw } from '../src/email/html';
import { firstName, scheduleTemplate, timeOffRequestedTemplate } from '../src/email/templates';
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
      labelColor: 'red;background:url(evil)',
      tierName: 'Tier "1"',
      tierColor: '#4f46e5',
      notes: 'Use the <back> door',
      needsConfirmation: true,
    };
    const email = scheduleTemplate(ctx, {
      recipientName: 'Jo <b>Bold</b>',
      tz: 'America/Toronto',
      tierName: 'Tier "1"',
      startDate: '2026-10-05',
      endDate: '2026-10-11',
      scheduleId: 'sched-1',
      firstPublish: true,
      added: [shift],
      updated: [],
      removed: [],
    });
    expect(email.html).not.toContain('<script>');
    expect(email.html).toContain('&lt;script&gt;');
    expect(email.html).toContain('Use the &lt;back&gt; door');
    expect(email.html).not.toContain('url(evil)'); // invalid colors fall back
    expect(email.html).toContain('Acme &lt;Support&gt;');
    expect(email.html).toContain('https://schedule.example.com/confirm-shift/shift-1');
    expect(email.text).toContain('Hi Jo,');
    expect(email.text).toContain('Tue, Oct 6 · 9:00 AM – 5:00 PM');
    expect(email.text).toContain('Times are shown in EDT (America/Toronto).');
    expect(email.subject).toBe('Your Tier "1" schedule for Oct 5 – 11, 2026 is ready');
  });

  it('keeps subjects on one line', () => {
    const email = timeOffRequestedTemplate(ctx, {
      recipientName: 'Admin',
      requesterName: 'Line\nBreak',
      typeName: 'Vacation',
      startDate: '2026-10-05',
      endDate: '2026-10-05',
      note: null,
      conflicts: 0,
    });
    expect(email.subject).not.toMatch(/[\r\n]/);
    expect(email.text).toContain('(1 day)');
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
