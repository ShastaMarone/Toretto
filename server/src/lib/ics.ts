import { addDays, type ISODate } from '@shared/time';

/**
 * Just enough iCalendar (RFC 5545) for a read-only feed that calendar apps
 * subscribe to: timed events in UTC, and all-day events.
 */

export interface IcsEvent {
  /** Stays the same between fetches, so apps update the event instead of adding another. */
  uid: string;
  summary: string;
  description?: string;
  /** UTC instants, or whole days (the last day included). */
  when: { start: string; end: string } | { firstDay: ISODate; lastDay: ISODate };
  /** Show the time as free rather than busy, e.g. a day off. */
  free?: boolean;
}

export function icsCalendar({
  name,
  description,
  events,
  now = new Date(),
}: {
  name: string;
  description?: string;
  events: IcsEvent[];
  now?: Date;
}): string {
  const stamp = utc(now);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Toretto//Shifts//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `NAME:${text(name)}`,
    `X-WR-CALNAME:${text(name)}`,
    ...(description
      ? [`DESCRIPTION:${text(description)}`, `X-WR-CALDESC:${text(description)}`]
      : []),
    // How often to check for changes. Outlook and Apple Calendar go by this;
    // Google Calendar keeps its own schedule.
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
  ];
  for (const event of events) {
    const { when } = event;
    lines.push(
      'BEGIN:VEVENT',
      `UID:${text(event.uid)}`,
      `DTSTAMP:${stamp}`,
      ...('firstDay' in when
        ? [
            `DTSTART;VALUE=DATE:${compactDate(when.firstDay)}`,
            // The end of an all-day event is the day after its last day.
            `DTEND;VALUE=DATE:${compactDate(addDays(when.lastDay, 1))}`,
          ]
        : [`DTSTART:${utc(new Date(when.start))}`, `DTEND:${utc(new Date(when.end))}`]),
      `SUMMARY:${text(event.summary)}`,
    );
    if (event.description) lines.push(`DESCRIPTION:${text(event.description)}`);
    if (event.free) lines.push('TRANSP:TRANSPARENT');
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

/** 20261012T130000Z */
function utc(date: Date): string {
  return date
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/[-:]/g, '');
}

/** 20261012 */
function compactDate(date: ISODate): string {
  return date.replaceAll('-', '');
}

/** A TEXT value: backslash, semicolon, comma and line breaks escaped; other control characters dropped. */
export function text(value: string): string {
  return [...value.replace(/\r\n?/g, '\n')]
    .filter((c) => c === '\t' || c === '\n' || (c >= ' ' && c !== '\u007f'))
    .join('')
    .replace(/[\\;,]/g, (c) => `\\${c}`)
    .replace(/\n/g, '\\n');
}

/**
 * Lines longer than 75 bytes carry on in the next line after a space (the
 * space counts toward that line's 75), never splitting a character.
 */
export function fold(line: string): string {
  let out = '';
  let width = 0;
  for (const char of line) {
    const size = Buffer.byteLength(char);
    if (width + size > 75) {
      out += '\r\n ';
      width = 1;
    }
    out += char;
    width += size;
  }
  return out;
}
