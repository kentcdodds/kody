-- Rotate keeps one previous URL secret hash live for a short overlap so
-- providers can finish switching. Ingress accepts the previous hash until
-- a delivery arrives on the new URL, or until previous_url_secret_expires_at.
-- The previous ciphertext is not stored: reveal / apply always use the current URL.
ALTER TABLE webhook_endpoints ADD COLUMN previous_url_secret_hash TEXT;
ALTER TABLE webhook_endpoints ADD COLUMN previous_url_secret_expires_at TEXT;
