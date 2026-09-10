-- Person-to-person per-package share grants. Distinct from platform
-- package_scope_grants (admin-minted, full authoring under a platform
-- scope). These rows are invitations to *use* one saved package: read
-- source + invoke, never publish/write. Invite-before-signup keeps a
-- pending row keyed by email until the guest accepts.
CREATE TABLE package_share_grants (
	id TEXT PRIMARY KEY NOT NULL,
	package_id TEXT NOT NULL,
	owner_user_id TEXT NOT NULL,
	invitee_email TEXT,
	invitee_username TEXT,
	grantee_user_id TEXT,
	status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'revoked', 'left')),
	role TEXT NOT NULL DEFAULT 'use' CHECK (role IN ('use')),
	trust_level TEXT CHECK (trust_level IN ('follow', 'pin') OR trust_level IS NULL),
	accepted_published_commit TEXT,
	invited_at TEXT NOT NULL,
	accepted_at TEXT,
	revoked_at TEXT,
	left_at TEXT,
	last_acknowledged_at TEXT,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	CHECK (invitee_email IS NOT NULL OR grantee_user_id IS NOT NULL)
);

CREATE INDEX idx_package_share_grants_package_id
ON package_share_grants(package_id);

CREATE INDEX idx_package_share_grants_owner_user_id
ON package_share_grants(owner_user_id);

CREATE INDEX idx_package_share_grants_grantee_user_id
ON package_share_grants(grantee_user_id);

CREATE INDEX idx_package_share_grants_invitee_email
ON package_share_grants(invitee_email);

CREATE UNIQUE INDEX idx_package_share_grants_active_email
ON package_share_grants(package_id, invitee_email)
WHERE status IN ('pending', 'accepted') AND invitee_email IS NOT NULL;

CREATE UNIQUE INDEX idx_package_share_grants_active_grantee
ON package_share_grants(package_id, grantee_user_id)
WHERE status IN ('pending', 'accepted') AND grantee_user_id IS NOT NULL;
