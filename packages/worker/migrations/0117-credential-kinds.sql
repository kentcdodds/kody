-- Credential kinds (ADR 0068): a stored credential is a `secret` (placed by
-- its `inject_json`), or one of the later kinds, each with its own resolver
-- behind `resolveCredential`:
--   url      the value is a whole HTTPS URL pinned to the credential's hosts
--   login    the value holds login fields; the gateway runs the exchange
--   signing  the value is key material; the gateway signs or verifies
--
-- Every existing row is a `secret`. Placeholders keep filling `secret` rows
-- only, so a later kind's value is never placed by package code.

ALTER TABLE secret_entries ADD COLUMN kind TEXT NOT NULL DEFAULT 'secret'
	CHECK (kind IN ('secret', 'url', 'login', 'signing'));
