-- Someone offers one of their published shifts to a coworker in their tier,
-- optionally taking one of the coworker's shifts in return. The coworker
-- accepts, an admin approves, and the shifts change hands.
CREATE TABLE shift_swaps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id uuid NOT NULL REFERENCES shifts (id) ON DELETE CASCADE,
  requester_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  recipient_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- A trade: the coworker's shift the requester takes in return.
  return_shift_id uuid REFERENCES shifts (id) ON DELETE CASCADE,
  note text CHECK (length(note) <= 500),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN
    ('pending', 'accepted', 'approved', 'declined', 'denied', 'cancelled', 'expired')),
  responded_at timestamptz,
  reviewed_by uuid REFERENCES users (id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  review_note text CHECK (length(review_note) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (recipient_id <> requester_id),
  CHECK (return_shift_id <> shift_id)
);
CREATE INDEX shift_swaps_requester_idx ON shift_swaps (requester_id, created_at DESC);
CREATE INDEX shift_swaps_recipient_idx ON shift_swaps (recipient_id, created_at DESC);
CREATE INDEX shift_swaps_created_idx ON shift_swaps (created_at DESC);
-- A shift is in at most one open swap at a time.
CREATE UNIQUE INDEX shift_swaps_open_shift ON shift_swaps (shift_id)
  WHERE status IN ('pending', 'accepted');
CREATE UNIQUE INDEX shift_swaps_open_return ON shift_swaps (return_shift_id)
  WHERE status IN ('pending', 'accepted');
CREATE TRIGGER shift_swaps_updated_at BEFORE UPDATE ON shift_swaps
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Admins choose whether they're emailed about swaps (and open shifts).
ALTER TABLE users ADD COLUMN notify_swaps boolean NOT NULL DEFAULT true;
