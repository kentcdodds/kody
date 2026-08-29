-- Drop the retired per-secret capability allowlist. Secrets are consumed by
-- fetch placeholders (host approval) and package grants, not by capability
-- input placeholders.
ALTER TABLE secret_entries DROP COLUMN allowed_capabilities;
