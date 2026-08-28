-- First-touch marketing attribution (write-once at signup) and factory
-- activation first-seen stamps for GTM readout. Invite codes stay the access
-- key; UTMs are the acquisition story. Activation timestamps are set on first
-- event only (COALESCE). last_active_at supports D2/D7 return math.

ALTER TABLE users ADD COLUMN utm_source TEXT;
ALTER TABLE users ADD COLUMN utm_medium TEXT;
ALTER TABLE users ADD COLUMN utm_campaign TEXT;
ALTER TABLE users ADD COLUMN utm_content TEXT;
ALTER TABLE users ADD COLUMN utm_term TEXT;
ALTER TABLE users ADD COLUMN first_touch_landing_path TEXT;
ALTER TABLE users ADD COLUMN first_touch_referrer TEXT;

ALTER TABLE users ADD COLUMN first_mcp_connected_at TEXT;
ALTER TABLE users ADD COLUMN first_execute_at TEXT;
ALTER TABLE users ADD COLUMN first_saved_package_at TEXT;
ALTER TABLE users ADD COLUMN mcp_client_name TEXT;
ALTER TABLE users ADD COLUMN last_active_at TEXT;
