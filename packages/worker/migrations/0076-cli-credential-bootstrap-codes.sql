-- One-shot CLI credential bootstrap codes (ADR 0056). Minted by
-- `cliCredentialBootstrap` (capability / Open API); redeemed once by the CLI
-- via `POST /v1/tokens/bootstrap/redeem` for a normal `kody_at_` API token.
-- Only the SHA-256 of the plaintext code is stored.
CREATE TABLE cli_credential_bootstrap_codes (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	code_hash TEXT NOT NULL UNIQUE,
	name TEXT NOT NULL,
	scopes_json TEXT NOT NULL,
	idle_ttl_seconds INTEGER NOT NULL,
	max_lifetime_seconds INTEGER NOT NULL,
	expires_at TEXT NOT NULL,
	created_at TEXT NOT NULL,
	consumed_at TEXT
);

CREATE INDEX cli_credential_bootstrap_codes_user_created_idx
	ON cli_credential_bootstrap_codes (user_id, created_at);
