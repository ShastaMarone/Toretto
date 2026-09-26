-- Shifts nobody has yet, posted for everyone in a tier. The first person to
-- pick one up holds it until an admin approves (it becomes their shift) or
-- declines (it's open again, but not for them).
CREATE TABLE open_shifts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id uuid NOT NULL REFERENCES schedules (id) ON DELETE CASCADE,
  tier_id uuid NOT NULL REFERENCES tiers (id) ON DELETE CASCADE,
  label_id uuid REFERENCES labels (id) ON DELETE SET NULL,
  start_time timestamptz NOT NULL,
  end_time timestamptz NOT NULL,
  notes text CHECK (length(notes) <= 500),
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'claimed', 'filled', 'cancelled', 'expired')),
  claimed_by uuid REFERENCES users (id) ON DELETE SET NULL,
  claimed_at timestamptz,
  -- People an admin turned down for it.
  declined_ids uuid[] NOT NULL DEFAULT '{}',
  reviewed_by uuid REFERENCES users (id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  -- The shift it became.
  shift_id uuid REFERENCES shifts (id) ON DELETE SET NULL,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_time > start_time)
);
CREATE INDEX open_shifts_status_idx ON open_shifts (status, start_time);
CREATE INDEX open_shifts_tier_idx ON open_shifts (tier_id, start_time);
CREATE TRIGGER open_shifts_updated_at BEFORE UPDATE ON open_shifts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
