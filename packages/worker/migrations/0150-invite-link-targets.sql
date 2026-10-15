-- Invite links can carry a team or one resource grant, not only org
-- membership. `kind` says which: `membership` (every existing row) adds the
-- recipient with `role`; `team` adds them as a member (keeping an existing
-- role) and to `team_id`; `resource` grants `preset` on one resource and leaves
-- non-members as outside collaborators, so `role` is null and the org may be a
-- personal org. SQLite cannot relax the `role` CHECK in place, so the table is
-- rebuilt with every existing row copied as `membership`.

CREATE TABLE org_invite_links_next (
	id TEXT PRIMARY KEY NOT NULL,
	org_id TEXT NOT NULL,
	token_hash TEXT NOT NULL UNIQUE,
	kind TEXT NOT NULL DEFAULT 'membership'
		CHECK (kind IN ('membership', 'team', 'resource')),
	role TEXT CHECK (role IS NULL OR role IN ('member', 'billing')),
	team_id TEXT,
	resource_type TEXT CHECK (resource_type IS NULL OR resource_type = 'package'),
	resource_id TEXT,
	preset TEXT CHECK (preset IS NULL OR preset IN ('use', 'contribute', 'manage')),
	allowed_email_domains_json TEXT,
	max_uses INTEGER CHECK (max_uses IS NULL OR max_uses > 0),
	use_count INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0),
	status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
	created_by_user_id TEXT NOT NULL,
	expires_at TEXT NOT NULL,
	created_at TEXT NOT NULL,
	revoked_at TEXT,
	CHECK (
		(kind = 'membership' AND role IS NOT NULL AND team_id IS NULL
			AND resource_type IS NULL AND resource_id IS NULL AND preset IS NULL)
		OR (kind = 'team' AND role = 'member' AND team_id IS NOT NULL
			AND resource_type IS NULL AND resource_id IS NULL AND preset IS NULL)
		OR (kind = 'resource' AND role IS NULL AND team_id IS NULL
			AND resource_type IS NOT NULL AND resource_id IS NOT NULL
			AND preset IS NOT NULL)
	)
);

INSERT INTO org_invite_links_next (
	id,
	org_id,
	token_hash,
	kind,
	role,
	allowed_email_domains_json,
	max_uses,
	use_count,
	status,
	created_by_user_id,
	expires_at,
	created_at,
	revoked_at
)
SELECT
	id,
	org_id,
	token_hash,
	'membership',
	role,
	allowed_email_domains_json,
	max_uses,
	use_count,
	status,
	created_by_user_id,
	expires_at,
	created_at,
	revoked_at
FROM org_invite_links;

DROP INDEX IF EXISTS org_invite_links_org_status_idx;
DROP TABLE org_invite_links;
ALTER TABLE org_invite_links_next RENAME TO org_invite_links;

CREATE INDEX org_invite_links_org_status_idx
	ON org_invite_links (org_id, status, expires_at);

CREATE INDEX org_invite_links_resource_idx
	ON org_invite_links (org_id, resource_type, resource_id, status);

CREATE INDEX org_invite_links_team_idx
	ON org_invite_links (org_id, team_id, status);

-- A signed-in person who opened a link and has not accepted or declined it.
-- Lists the invite on their Organizations page. Holding a row is proof they
-- had the token, so accepting from that list does not need it again.
CREATE TABLE org_invite_link_pending (
	link_id TEXT NOT NULL,
	user_id TEXT NOT NULL,
	created_at TEXT NOT NULL,
	PRIMARY KEY (link_id, user_id)
);

CREATE INDEX org_invite_link_pending_user_idx
	ON org_invite_link_pending (user_id);
