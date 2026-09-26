import type { ScheduleSummary } from '@shared/types';
import { Badge } from '../ui/Misc';

export function StatusBadge({ schedule }: { schedule: ScheduleSummary }) {
  if (schedule.status === 'draft') return <Badge tone="gray">Draft</Badge>;
  if (schedule.pendingChanges > 0) {
    return <Badge tone="amber">Published · {schedule.pendingChanges} unpublished</Badge>;
  }
  return <Badge tone="green">Published</Badge>;
}
