-- Each swap remembers which published version of its shifts it's about (a
-- shift's published_at changes when it's republished with a different person,
-- time or label), so a rescheduled shift can't change hands on the old terms.
ALTER TABLE shift_swaps
  ADD COLUMN shift_version timestamptz,
  ADD COLUMN return_version timestamptz;
-- 'changed': one of its shifts was republished differently, so it lapsed.
ALTER TABLE shift_swaps DROP CONSTRAINT shift_swaps_status_check;
ALTER TABLE shift_swaps ADD CONSTRAINT shift_swaps_status_check CHECK (status IN
  ('pending', 'accepted', 'approved', 'declined', 'denied', 'cancelled', 'expired', 'changed'));

-- Deleting someone who picked up an open shift puts it back up for grabs,
-- rather than leaving it picked up by nobody.
CREATE FUNCTION reopen_open_shift_claims() RETURNS trigger AS $$
BEGIN
  UPDATE open_shifts SET status = 'open', claimed_by = NULL, claimed_at = NULL
   WHERE claimed_by = OLD.id AND status = 'claimed';
  RETURN OLD;
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER users_reopen_open_shift_claims BEFORE DELETE ON users
  FOR EACH ROW EXECUTE FUNCTION reopen_open_shift_claims();

-- A picked-up open shift always has someone holding it (any left holding
-- nobody by an earlier deletion are reopened first).
UPDATE open_shifts SET status = 'open', claimed_at = NULL
 WHERE status = 'claimed' AND claimed_by IS NULL;
ALTER TABLE open_shifts ADD CONSTRAINT open_shifts_claim_check
  CHECK (status <> 'claimed' OR claimed_by IS NOT NULL);

-- Part-day time off has both a start and an end (the hours check lets a lone
-- start through). Any with only one are whole days.
UPDATE time_off_requests SET start_time = NULL, end_time = NULL
 WHERE (start_time IS NULL) <> (end_time IS NULL);
ALTER TABLE time_off_requests ADD CONSTRAINT time_off_requests_hours_pair_check
  CHECK ((start_time IS NULL) = (end_time IS NULL));
