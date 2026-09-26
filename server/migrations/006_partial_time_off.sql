-- Time off for part of a day: its exact start and end. Whole days leave both
-- empty. start_date and end_date are always the (organization's) calendar
-- days it falls on.
ALTER TABLE time_off_requests
  ADD COLUMN start_time timestamptz,
  ADD COLUMN end_time timestamptz,
  ADD CONSTRAINT time_off_requests_hours_check CHECK (
    (start_time IS NULL AND end_time IS NULL)
    OR (end_time > start_time AND end_time - start_time <= interval '24 hours')
  );
