-- Platform abuse controls on user accounts:
-- - suspended_at: operator-set platform suspension. A suspended account is
--   blocked at the browser session, MCP, and email chokepoints until an
--   admin clears it.
-- - email_outbound_paused_at: automatic outbound-email pause set when
--   provider delivery events report a spam complaint or repeated bounces,
--   protecting the shared user email domain's sender reputation. Cleared
--   by an admin after review.
ALTER TABLE users ADD COLUMN suspended_at TEXT;
ALTER TABLE users ADD COLUMN email_outbound_paused_at TEXT;
