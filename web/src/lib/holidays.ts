import { holidaysBetween, type Holiday } from '@shared/holidays';
import { useMemo } from 'react';
import { useBootstrapData } from './session';

/** Statutory holidays (for the organization's region) between two days. */
export function useHolidays(from: string, to: string): Map<string, Holiday[]> {
  const { org } = useBootstrapData();
  return useMemo(() => holidaysBetween(org.holidayRegion, from, to), [org.holidayRegion, from, to]);
}
