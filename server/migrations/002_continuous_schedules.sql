-- Schedules become open-ended calendars that cover every tier. Every existing
-- per-tier schedule is merged into one default "Main schedule". Each shift
-- keeps its published snapshot, so nothing changes for the team. Admins can
-- add more schedules for separate rosters.

ALTER TABLE schedules ADD COLUMN is_default boolean NOT NULL DEFAULT false;
ALTER TABLE schedules ALTER COLUMN tier_id DROP NOT NULL;

INSERT INTO schedules (name, start_date, end_date, is_default)
VALUES ('Main schedule', '2000-01-01', '2000-01-01', true);

UPDATE schedules main
   SET published_at = latest.published_at, published_by = latest.published_by
  FROM (SELECT published_at, published_by FROM schedules
         WHERE NOT is_default AND published_at IS NOT NULL
         ORDER BY published_at DESC
         LIMIT 1) latest
 WHERE main.is_default;

UPDATE shifts SET schedule_id = (SELECT id FROM schedules WHERE is_default);
DELETE FROM schedules WHERE NOT is_default;

DROP INDEX IF EXISTS schedules_tier_idx;
ALTER TABLE schedules
  DROP COLUMN tier_id,
  DROP COLUMN start_date,
  DROP COLUMN end_date,
  DROP COLUMN status,
  ALTER COLUMN name SET NOT NULL,
  ADD CONSTRAINT schedules_name_not_blank CHECK (length(btrim(name)) > 0);
COMMENT ON COLUMN schedules.published_at IS 'When changes were last published';
CREATE UNIQUE INDEX schedules_single_default ON schedules (is_default) WHERE is_default;
CREATE UNIQUE INDEX schedules_name_unique ON schedules (lower(name));
CREATE INDEX shifts_schedule_time_idx ON shifts (schedule_id, start_time);

-- Admins choose which activity emails they get.
ALTER TABLE users
  ADD COLUMN notify_time_off boolean NOT NULL DEFAULT true,
  ADD COLUMN notify_confirmations boolean NOT NULL DEFAULT true;

-- Statutory holidays shown on calendars: 'CA' is the Canada Labour Code
-- (federally regulated employers); otherwise a province or territory.
ALTER TABLE org_settings
  ADD COLUMN holiday_region text NOT NULL DEFAULT 'CA'
    CHECK (holiday_region IN
      ('none', 'CA', 'AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT'));
