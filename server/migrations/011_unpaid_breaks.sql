-- Minutes of unpaid break (a lunch that isn't paid) taken off each longer shift
-- of people in this tier when hours and overtime are counted.
ALTER TABLE tiers
  ADD COLUMN unpaid_break_minutes integer NOT NULL DEFAULT 0
    CHECK (unpaid_break_minutes BETWEEN 0 AND 240);
