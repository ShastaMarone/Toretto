-- Each person's secret calendar feed link (for Google Calendar and other
-- calendar apps). Unlike sign-in tokens it's stored as-is so the link can be
-- shown again, and it only reads what this database already holds.
ALTER TABLE users ADD COLUMN calendar_token text UNIQUE;
