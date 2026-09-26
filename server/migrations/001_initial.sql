-- Toretto initial schema.
-- Timestamps are timestamptz (stored in UTC). Calendar days (schedule periods,
-- time off) are plain dates interpreted in the organization's time zone.

CREATE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

-- Single-row organization settings.
CREATE TABLE org_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  org_name text NOT NULL DEFAULT 'My Team',
  timezone text NOT NULL DEFAULT 'America/Toronto',
  week_starts_on smallint NOT NULL DEFAULT 1 CHECK (week_starts_on IN (0, 1)),
  -- Send one reminder when a published shift is still unconfirmed after this
  -- many hours. 0 disables reminders.
  reminder_hours integer NOT NULL DEFAULT 24 CHECK (reminder_hours BETWEEN 0 AND 336),
  self_signup boolean NOT NULL DEFAULT false,
  allowed_domains text[] NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO org_settings DEFAULT VALUES;
CREATE TRIGGER org_settings_updated_at BEFORE UPDATE ON org_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE tiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  color text NOT NULL CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX tiers_name_unique ON tiers (lower(name));
CREATE TRIGGER tiers_updated_at BEFORE UPDATE ON tiers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX teams_name_unique ON teams (lower(name));
CREATE TRIGGER teams_updated_at BEFORE UPDATE ON teams
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  email text NOT NULL CHECK (email = lower(email)),
  password_hash text,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  tier_id uuid REFERENCES tiers (id) ON DELETE SET NULL,
  team_id uuid REFERENCES teams (id) ON DELETE SET NULL,
  -- IANA zone; NULL means "use the organization time zone".
  timezone text,
  email_verified_at timestamptz,
  invited_at timestamptz,
  invited_by uuid REFERENCES users (id) ON DELETE SET NULL,
  deactivated_at timestamptz,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_unique ON users (email);
CREATE INDEX users_tier_idx ON users (tier_id);
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Server-side sessions. The id is the SHA-256 of the cookie token, so a
-- database leak does not leak usable session cookies.
CREATE TABLE sessions (
  id text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

-- Single-use links sent by email (confirm email, invite, password reset,
-- magic sign-in link). Stored hashed, like sessions.
CREATE TABLE auth_tokens (
  id text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  purpose text NOT NULL
    CHECK (purpose IN ('verify_email', 'invite', 'reset_password', 'magic_link')),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_tokens_user_idx ON auth_tokens (user_id, purpose);

-- Admin-defined shift labels ("On-Call", "Training", ...). A NULL tier_id
-- means the label is available to every tier.
CREATE TABLE labels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tier_id uuid REFERENCES tiers (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  color text NOT NULL CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX labels_name_unique
  ON labels (COALESCE(tier_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));
CREATE TRIGGER labels_updated_at BEFORE UPDATE ON labels
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A schedule is one tier's roster for a date range. It starts as a draft and
-- becomes visible to the team once published.
CREATE TABLE schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tier_id uuid NOT NULL REFERENCES tiers (id) ON DELETE RESTRICT,
  name text CHECK (length(name) <= 80),
  start_date date NOT NULL,
  end_date date NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  published_at timestamptz,
  published_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date),
  CHECK (end_date - start_date < 42)
);
CREATE INDEX schedules_tier_idx ON schedules (tier_id, start_date);
CREATE TRIGGER schedules_updated_at BEFORE UPDATE ON schedules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Shifts hold two copies of their data:
--   * the working copy (user_id, label_id, start_time, ...) that admins edit;
--   * the published_* snapshot that team members see.
-- Publishing copies the working copy into the snapshot and emails whoever is
-- affected. Deleting a published shift only sets deleted_at, so the team keeps
-- seeing it until the change is published (and the assignee is told).
CREATE TABLE shifts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id uuid NOT NULL REFERENCES schedules (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  label_id uuid REFERENCES labels (id) ON DELETE SET NULL,
  start_time timestamptz NOT NULL,
  end_time timestamptz NOT NULL,
  notes text CHECK (length(notes) <= 500),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed')),
  confirmed_at timestamptz,
  published_at timestamptz,
  published_user_id uuid REFERENCES users (id) ON DELETE RESTRICT,
  published_label_id uuid REFERENCES labels (id) ON DELETE SET NULL,
  published_start_time timestamptz,
  published_end_time timestamptz,
  published_notes text,
  deleted_at timestamptz,
  reminder_sent_at timestamptz,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_time > start_time)
);
CREATE INDEX shifts_schedule_idx ON shifts (schedule_id);
CREATE INDEX shifts_user_time_idx ON shifts (user_id, start_time);
CREATE INDEX shifts_published_user_idx ON shifts (published_user_id, published_start_time)
  WHERE published_at IS NOT NULL;
CREATE INDEX shifts_published_time_idx ON shifts (published_start_time)
  WHERE published_at IS NOT NULL;
CREATE TRIGGER shifts_updated_at BEFORE UPDATE ON shifts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE time_off_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  color text NOT NULL CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
  paid boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX time_off_types_name_unique ON time_off_types (lower(name));
CREATE TRIGGER time_off_types_updated_at BEFORE UPDATE ON time_off_types
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO time_off_types (name, color, paid, sort_order) VALUES
  ('Paid Holiday', '#0ea5e9', true, 1),
  ('Personal Day', '#8b5cf6', true, 2),
  ('Vacation', '#10b981', true, 3),
  ('Sick Day', '#f59e0b', true, 4),
  ('Unpaid Leave', '#64748b', false, 5);

CREATE TABLE time_off_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  type_id uuid NOT NULL REFERENCES time_off_types (id) ON DELETE RESTRICT,
  start_date date NOT NULL,
  end_date date NOT NULL,
  note text CHECK (length(note) <= 500),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'denied', 'cancelled')),
  reviewed_by uuid REFERENCES users (id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  review_note text CHECK (length(review_note) <= 500),
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date),
  CHECK (end_date - start_date < 366)
);
CREATE INDEX time_off_user_idx ON time_off_requests (user_id, start_date);
CREATE INDEX time_off_status_idx ON time_off_requests (status, start_date);
CREATE TRIGGER time_off_requests_updated_at BEFORE UPDATE ON time_off_requests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Email outbox + notification log. Requests only insert rows here; the
-- background worker delivers them (with retries), so no request ever waits
-- on the email provider.
CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  kind text NOT NULL,
  to_email text NOT NULL,
  subject text NOT NULL,
  html text NOT NULL,
  text text NOT NULL,
  schedule_id uuid REFERENCES schedules (id) ON DELETE SET NULL,
  shift_ids uuid[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sending', 'sent', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  run_after timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  sent_at timestamptz,
  provider_message_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_queue_idx ON notifications (run_after) WHERE status = 'queued';
CREATE INDEX notifications_created_idx ON notifications (created_at DESC);
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);

-- Who did what, when (publishes, confirmations, approvals, edits...).
CREATE TABLE audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id uuid REFERENCES users (id) ON DELETE SET NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_created_idx ON audit_log (created_at DESC);
CREATE INDEX audit_log_entity_idx ON audit_log (entity_type, entity_id);
