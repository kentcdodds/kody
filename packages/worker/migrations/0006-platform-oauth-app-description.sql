-- Operator-authored description for platform (built-in) OAuth apps: shown on
-- the connect page and in integration_platform_app_list so users and agents
-- learn provider-specific limitations (for example send-only Gmail) before
-- connecting.
ALTER TABLE platform_oauth_apps ADD COLUMN description TEXT;
