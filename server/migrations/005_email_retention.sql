-- How long the email log keeps sent and failed emails, in days (null: forever).
-- The audit trail is kept regardless.
ALTER TABLE org_settings
  ADD COLUMN email_retention_days integer DEFAULT 90 CHECK (email_retention_days BETWEEN 1 AND 3650);
