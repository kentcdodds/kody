-- Package-owned webhook HMAC signing material (not a user secrets-list entry).
-- Minted with the URL when verification is declared without secretName, or
-- migrated from a legacy verification.secretName on first {{webhookSecret}} apply.
ALTER TABLE webhook_endpoints ADD COLUMN hmac_secret_encrypted TEXT;
