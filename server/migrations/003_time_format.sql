-- How times are written in the app and in emails: "3:00 PM" or "15:00".
-- The organization sets the default; each person can pick their own.
ALTER TABLE org_settings
  ADD COLUMN time_format text NOT NULL DEFAULT '12h' CHECK (time_format IN ('12h', '24h'));
ALTER TABLE users
  ADD COLUMN time_format text CHECK (time_format IN ('12h', '24h'));
