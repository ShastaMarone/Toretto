import { useMemo } from 'react';
import { allZones, COMMON_ZONES, zoneLabel } from '../lib/timezones';
import { Select } from './ui/Form';

export function TimezoneSelect({
  value,
  onChange,
  defaultOption,
  ...props
}: {
  value: string;
  onChange: (zone: string) => void;
  /** Optional first entry meaning "no personal zone" (value ''). */
  defaultOption?: string;
  required?: boolean;
  name?: string;
}) {
  const zones = useMemo(() => {
    const common = COMMON_ZONES.filter((z) => z !== value);
    const rest = allZones().filter((z) => !COMMON_ZONES.includes(z) && z !== value);
    return { common, rest };
  }, [value]);
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)} {...props}>
      {defaultOption !== undefined && <option value="">{defaultOption}</option>}
      {value && <option value={value}>{zoneLabel(value)}</option>}
      <optgroup label="Common">
        {zones.common.map((z) => (
          <option key={z} value={z}>
            {zoneLabel(z)}
          </option>
        ))}
      </optgroup>
      <optgroup label="All time zones">
        {zones.rest.map((z) => (
          <option key={z} value={z}>
            {z.replace(/_/g, ' ')}
          </option>
        ))}
      </optgroup>
    </Select>
  );
}
