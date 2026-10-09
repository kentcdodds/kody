-- Teams P8 data conversion (spec 11.2): package shares become cross-org Use
-- grants, platform scope grantees become Owners, platform accounts become
-- ordinary paid orgs, and only @kody gets the site-admin credit. Expand-only:
-- package_share_grants, package_scope_grants, and users.account_type stay
-- until P9 drops them.
--
-- Accepted shares: one live grant (preset use: package:read, package:execute)
-- from the owner's org to the grantee, with a deterministic id derived from
-- the share id. A live grant that already covers the pair keeps its id; it is
-- topped up with package:read and package:execute (a read-only grant gains
-- execute) and relabelled `use` only when it holds nothing beyond those two.
--
-- Pending shares: one grant invite (preset use) per share. Old share invite
-- links are invalid after this migration: the old tokens were never stored in
-- a form this table can reuse, so each converted invite gets a fresh random
-- token hash that nobody holds. Owners re-send from the new invite UI. The
-- expiry window restarts at migration time so converted invites are not dead
-- on arrival.
--
-- Revoked and left shares are not converted. Their rows stay for the P9 drop.
--
-- trust_level and accepted_published_commit (pin/follow) are not carried over.
--
-- Fail-closed assertions at the end use the __migration_assertions pattern
-- from 0089. D1 rejects TEMP tables, so the one helper table is a normal
-- table dropped before the end of the file.

-- Population preconditions. Shares whose package, owner org, or grantee no
-- longer exist cannot become grants and are left for the P9 drop.
DROP TABLE IF EXISTS __p8_accepted_shares;
CREATE TABLE __p8_accepted_shares (
	share_id TEXT NOT NULL PRIMARY KEY,
	org_id TEXT NOT NULL,
	package_id TEXT NOT NULL,
	grantee_user_id TEXT NOT NULL,
	granted_at TEXT NOT NULL
);

INSERT INTO __p8_accepted_shares (
	share_id,
	org_id,
	package_id,
	grantee_user_id,
	granted_at
)
SELECT
	s.id,
	s.owner_user_id,
	s.package_id,
	s.grantee_user_id,
	COALESCE(s.accepted_at, s.invited_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
FROM package_share_grants s
WHERE s.status = 'accepted'
	AND s.grantee_user_id IS NOT NULL
	AND s.grantee_user_id <> s.owner_user_id
	AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = s.owner_user_id)
	AND EXISTS (
		SELECT 1 FROM saved_packages p
		WHERE p.id = s.package_id AND p.user_id = s.owner_user_id
	)
	AND EXISTS (
		SELECT 1 FROM users g WHERE g.stable_user_id = s.grantee_user_id
	);

DROP TABLE IF EXISTS __p8_pending_shares;
CREATE TABLE __p8_pending_shares (
	share_id TEXT NOT NULL PRIMARY KEY,
	org_id TEXT NOT NULL,
	package_id TEXT NOT NULL,
	invitee_email TEXT,
	invitee_username TEXT,
	invited_at TEXT NOT NULL
);

-- The invite matches by email when the share has one, otherwise by username
-- (the share's own, or the grantee's current username).
INSERT INTO __p8_pending_shares (
	share_id,
	org_id,
	package_id,
	invitee_email,
	invitee_username,
	invited_at
)
SELECT
	resolved.id,
	resolved.owner_user_id,
	resolved.package_id,
	resolved.invitee_email,
	CASE WHEN resolved.invitee_email IS NULL THEN resolved.invitee_username END,
	resolved.invited_at
FROM (
	SELECT
		s.id,
		s.owner_user_id,
		s.package_id,
		NULLIF(LOWER(TRIM(COALESCE(s.invitee_email, ''))), '') AS invitee_email,
		COALESCE(
			NULLIF(LOWER(TRIM(COALESCE(s.invitee_username, ''))), ''),
			(
				SELECT LOWER(g.username) FROM users g
				WHERE g.stable_user_id = s.grantee_user_id
			)
		) AS invitee_username,
		COALESCE(s.invited_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) AS invited_at
	FROM package_share_grants s
	WHERE s.status = 'pending'
		AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = s.owner_user_id)
		AND EXISTS (
			SELECT 1 FROM saved_packages p
			WHERE p.id = s.package_id AND p.user_id = s.owner_user_id
		)
) resolved
WHERE resolved.invitee_email IS NOT NULL OR resolved.invitee_username IS NOT NULL;

-- 1. Accepted shares -> live Use grants.
INSERT INTO grants (
	id,
	org_id,
	resource_type,
	resource_id,
	subject_type,
	subject_id,
	preset,
	created_by_user_id,
	created_at,
	updated_at,
	deleted_at
)
SELECT
	'p8-share-' || a.share_id,
	a.org_id,
	'package',
	a.package_id,
	'user',
	a.grantee_user_id,
	'use',
	a.org_id,
	a.granted_at,
	strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
	NULL
FROM __p8_accepted_shares a
WHERE NOT EXISTS (
	SELECT 1 FROM grants g
	WHERE g.resource_type = 'package'
		AND g.resource_id = a.package_id
		AND g.subject_type = 'user'
		AND g.subject_id = a.grantee_user_id
		AND g.deleted_at IS NULL
);

-- Covers both the grants inserted above and any live grant that already
-- existed for the (package, user) pair, e.g. a read-only one.
INSERT OR IGNORE INTO grant_permissions (grant_id, permission)
SELECT g.id, p.permission
FROM grants g
INNER JOIN __p8_accepted_shares a
	ON g.resource_type = 'package'
	AND g.resource_id = a.package_id
	AND g.subject_type = 'user'
	AND g.subject_id = a.grantee_user_id
CROSS JOIN (
	SELECT 'package:read' AS permission
	UNION ALL
	SELECT 'package:execute'
) p
WHERE g.deleted_at IS NULL;

UPDATE grants
SET preset = 'use',
	updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE deleted_at IS NULL
	AND resource_type = 'package'
	AND subject_type = 'user'
	AND preset IS NOT 'use'
	AND EXISTS (
		SELECT 1 FROM __p8_accepted_shares a
		WHERE a.package_id = grants.resource_id
			AND a.grantee_user_id = grants.subject_id
	)
	AND NOT EXISTS (
		SELECT 1 FROM grant_permissions gp
		WHERE gp.grant_id = grants.id
			AND gp.permission NOT IN ('package:read', 'package:execute')
	);

UPDATE orgs
SET access_epoch = access_epoch + 1,
	updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id IN (SELECT org_id FROM __p8_accepted_shares);

-- 2. Pending shares -> pending grant invites (fresh unguessable token hash).
INSERT INTO invites (
	id,
	org_id,
	kind,
	role,
	team_ids_json,
	resource_type,
	resource_id,
	permissions_json,
	preset,
	invitee_email,
	invitee_username,
	token_hash,
	status,
	invited_by_user_id,
	accepted_by_user_id,
	expires_at,
	created_at,
	accepted_at
)
SELECT
	'p8-share-' || p.share_id,
	p.org_id,
	'grant',
	NULL,
	NULL,
	'package',
	p.package_id,
	NULL,
	'use',
	p.invitee_email,
	p.invitee_username,
	LOWER(HEX(RANDOMBLOB(32))),
	'pending',
	p.org_id,
	NULL,
	strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+30 days'),
	p.invited_at,
	NULL
FROM __p8_pending_shares p
WHERE NOT EXISTS (
	SELECT 1 FROM invites i
	WHERE i.org_id = p.org_id
		AND i.kind = 'grant'
		AND i.status = 'pending'
		AND i.resource_type = 'package'
		AND i.resource_id = p.package_id
		AND (
			(p.invitee_email IS NOT NULL AND i.invitee_email = p.invitee_email)
			OR (
				p.invitee_email IS NULL
				AND i.invitee_username = p.invitee_username
			)
		)
);

-- 4. Platform scope grantees -> Owner memberships on the scope owner's org.
-- An existing or soft-deleted membership is promoted to a live owner.
INSERT INTO org_memberships (
	org_id,
	user_id,
	role,
	invited_by_user_id,
	created_at,
	deleted_at
)
SELECT
	sg.scope_owner_user_id,
	sg.grantee_user_id,
	'owner',
	sg.created_by_user_id,
	COALESCE(sg.created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	NULL
FROM package_scope_grants sg
WHERE EXISTS (SELECT 1 FROM orgs o WHERE o.id = sg.scope_owner_user_id)
	AND EXISTS (
		SELECT 1 FROM users u WHERE u.stable_user_id = sg.grantee_user_id
	)
ON CONFLICT (org_id, user_id) DO UPDATE SET
	role = 'owner',
	deleted_at = NULL;

UPDATE orgs
SET access_epoch = access_epoch + 1,
	updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id IN (SELECT scope_owner_user_id FROM package_scope_grants);

-- 5. Platform accounts become ordinary paid orgs. Stripe is not touched.
UPDATE orgs
SET plan = 'pro',
	admin_credits_eligible = 1,
	updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id IN (
	SELECT stable_user_id FROM users WHERE account_type = 'platform'
);

-- Dual-write: admin and campaign paths still read plan and
-- admin_credits_eligible from users until Teams P9 drops those columns
-- (#3084), so the matching users rows get the same values.
UPDATE users
SET plan = 'pro',
	admin_credits_eligible = 1,
	updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE account_type = 'platform';

-- 6. Only @kody gets the $1,000 site-admin credit (100000 cents =
-- 1000000000 micro-USD). The ledger row goes in first, guarded by its note,
-- and the wallet is bumped only when that insert wrote a row (changes() = 1),
-- so a re-run never credits twice.
INSERT OR IGNORE INTO credit_wallets (user_id, created_at, updated_at)
SELECT
	u.stable_user_id,
	strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
	strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM users u
WHERE u.username = 'kody' AND u.account_type = 'platform';

INSERT INTO credit_ledger_entries (
	id,
	user_id,
	kind,
	amount_micro_usd,
	month,
	granted_by_user_id,
	note,
	created_at
)
SELECT
	'teams-p8-kody-site-admin-credit',
	u.stable_user_id,
	'admin_grant',
	1000000000,
	strftime('%Y-%m', 'now'),
	NULL,
	'Teams P8: site-admin credit for @kody org',
	strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM users u
WHERE u.username = 'kody'
	AND u.account_type = 'platform'
	AND NOT EXISTS (
		SELECT 1 FROM credit_ledger_entries l
		WHERE l.user_id = u.stable_user_id
			AND l.kind = 'admin_grant'
			AND l.note = 'Teams P8: site-admin credit for @kody org'
	);

UPDATE credit_wallets
SET balance_micro_usd = balance_micro_usd + 1000000000,
	updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE changes() = 1
	AND user_id IN (
		SELECT stable_user_id FROM users
		WHERE username = 'kody' AND account_type = 'platform'
	);

-- 7. Fail-closed invariants.
DROP TABLE IF EXISTS __migration_assertions;
CREATE TABLE __migration_assertions (
	message TEXT NOT NULL CHECK (0)
);

INSERT INTO __migration_assertions (message)
SELECT 'accepted package share has no live Use grant after Teams P8 conversion; aborting 0091.'
WHERE EXISTS (
	SELECT 1 FROM __p8_accepted_shares a
	WHERE NOT EXISTS (
		SELECT 1 FROM grants g
		INNER JOIN grant_permissions read_permission
			ON read_permission.grant_id = g.id
			AND read_permission.permission = 'package:read'
		INNER JOIN grant_permissions execute_permission
			ON execute_permission.grant_id = g.id
			AND execute_permission.permission = 'package:execute'
		WHERE g.org_id = a.org_id
			AND g.resource_type = 'package'
			AND g.resource_id = a.package_id
			AND g.subject_type = 'user'
			AND g.subject_id = a.grantee_user_id
			AND g.deleted_at IS NULL
	)
);

INSERT INTO __migration_assertions (message)
SELECT 'pending package share has no pending grant invite after Teams P8 conversion; aborting 0091.'
WHERE EXISTS (
	SELECT 1 FROM __p8_pending_shares p
	WHERE NOT EXISTS (
		SELECT 1 FROM invites i
		WHERE i.org_id = p.org_id
			AND i.kind = 'grant'
			AND i.status = 'pending'
			AND i.resource_type = 'package'
			AND i.resource_id = p.package_id
			AND (
				(p.invitee_email IS NOT NULL AND i.invitee_email = p.invitee_email)
				OR (
					p.invitee_email IS NULL
					AND i.invitee_username = p.invitee_username
				)
			)
	)
);

INSERT INTO __migration_assertions (message)
SELECT 'scope grantee has no owner membership after Teams P8 conversion; aborting 0091.'
WHERE EXISTS (
	SELECT 1
	FROM package_scope_grants sg
	WHERE EXISTS (SELECT 1 FROM orgs o WHERE o.id = sg.scope_owner_user_id)
		AND EXISTS (
			SELECT 1 FROM users u WHERE u.stable_user_id = sg.grantee_user_id
		)
		AND NOT EXISTS (
			SELECT 1 FROM org_memberships m
			WHERE m.org_id = sg.scope_owner_user_id
				AND m.user_id = sg.grantee_user_id
				AND m.role = 'owner'
				AND m.deleted_at IS NULL
		)
);

INSERT INTO __migration_assertions (message)
SELECT 'platform account has no org after Teams P8 conversion; aborting 0091.'
WHERE EXISTS (
	SELECT 1 FROM users u
	WHERE u.account_type = 'platform'
		AND NOT EXISTS (SELECT 1 FROM orgs o WHERE o.id = u.stable_user_id)
);

INSERT INTO __migration_assertions (message)
SELECT 'platform org is not plan pro with admin credits after Teams P8 conversion; aborting 0091.'
WHERE EXISTS (
	SELECT 1
	FROM users u
	INNER JOIN orgs o ON o.id = u.stable_user_id
	WHERE u.account_type = 'platform'
		AND (o.plan <> 'pro' OR o.admin_credits_eligible <> 1)
);

INSERT INTO __migration_assertions (message)
SELECT '@kody org is missing the site-admin credit ledger entry after Teams P8 conversion; aborting 0091.'
WHERE EXISTS (
	SELECT 1 FROM users u
	WHERE u.username = 'kody'
		AND u.account_type = 'platform'
		AND NOT EXISTS (
			SELECT 1 FROM credit_ledger_entries l
			WHERE l.user_id = u.stable_user_id
				AND l.kind = 'admin_grant'
				AND l.amount_micro_usd = 1000000000
				AND l.note = 'Teams P8: site-admin credit for @kody org'
		)
);

INSERT INTO __migration_assertions (message)
SELECT '@kody org wallet balance is below the site-admin credit after Teams P8 conversion; aborting 0091.'
WHERE EXISTS (
	SELECT 1 FROM users u
	WHERE u.username = 'kody'
		AND u.account_type = 'platform'
		AND COALESCE(
			(SELECT w.balance_micro_usd FROM credit_wallets w WHERE w.user_id = u.stable_user_id),
			0
		) < 1000000000
);

DROP TABLE __migration_assertions;
DROP TABLE __p8_accepted_shares;
DROP TABLE __p8_pending_shares;
