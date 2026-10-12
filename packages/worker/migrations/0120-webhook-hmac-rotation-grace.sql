-- Signing-secret rotation grace (24h), parallel to URL-secret overlap.
--
-- `hmac_secret_name` is the last-seen verification.secretName identity.
-- `hmac_verification_secret_encrypted` snapshots the last-seen declared
-- signing value (platform ciphertext only — never returned to package code
-- or MCP) so a later name or value change can move it into previous_*.
-- During previous_hmac_secret_expires_at, ingress accepts signatures under
-- either the current declared secret or the previous snapshot. Apply still
-- uses hmac_secret_encrypted only and is not rewritten on rotation.
ALTER TABLE webhook_endpoints ADD COLUMN hmac_secret_name TEXT;
ALTER TABLE webhook_endpoints ADD COLUMN hmac_verification_secret_encrypted TEXT;
ALTER TABLE webhook_endpoints ADD COLUMN previous_hmac_secret_name TEXT;
ALTER TABLE webhook_endpoints ADD COLUMN previous_hmac_secret_encrypted TEXT;
ALTER TABLE webhook_endpoints ADD COLUMN previous_hmac_secret_expires_at TEXT;
