-- Overtime is flagged past this many hours in a day or in a week (null: no
-- limit). The defaults are the Canada Labour Code's standard hours.
ALTER TABLE org_settings
  ADD COLUMN overtime_daily_hours numeric DEFAULT 8
    CHECK (overtime_daily_hours > 0 AND overtime_daily_hours <= 24),
  ADD COLUMN overtime_weekly_hours numeric DEFAULT 40
    CHECK (overtime_weekly_hours > 0 AND overtime_weekly_hours <= 168);
