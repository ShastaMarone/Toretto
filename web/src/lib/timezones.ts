import { tzAbbreviation } from '@shared/time';

export const COMMON_ZONES = [
  'America/St_Johns',
  'America/Halifax',
  'America/Toronto',
  'America/Winnipeg',
  'America/Regina',
  'America/Edmonton',
  'America/Vancouver',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Phoenix',
  'America/Los_Angeles',
  'Europe/London',
  'Asia/Kolkata',
  'Asia/Manila',
  'UTC',
];

export function allZones(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return COMMON_ZONES;
  }
}

export function browserZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export function zoneLabel(zone: string): string {
  let abbr = '';
  try {
    abbr = tzAbbreviation(zone);
  } catch {
    // unknown zone
  }
  return `${zone.replace(/_/g, ' ')}${abbr && abbr !== zone ? ` (${abbr})` : ''}`;
}
