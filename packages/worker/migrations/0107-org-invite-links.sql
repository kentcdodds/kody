-- Shareable org membership invite links. Distinct from addressed `invites`
-- (email/username, single accept): a link may be used many times, stores only
-- a token hash, and never grants Owner. Optionaled and maxed links stay
-- `active` until an admin revokes them; redeem checks expires_at and max_uses.
CREATE TABLE org_invite_links (
	id TEXT PRIMARY KEY NOT NULL,
	org_id TEXT NOT NULL,
	token_hash TEXT NOT NULL UNIQUE,
	role TEXT NOT NULL CHECK (role IN ('member', 'billing')),
	allowed_email_domains_json TEXT,
	max_uses INTEGER CHECK (max_uses IS NULL OR max_uses > 0),
	use_count INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0),
	status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
	created_by_user_id TEXT NOT NULL,
	expires_at TEXT NOT NULL,
	created_at TEXT NOT NULL,
	revoked_at TEXT
);

CREATE INDEX org_invite_links_org_status_idx
	ON org_invite_links (org_id, status, expires_at);
