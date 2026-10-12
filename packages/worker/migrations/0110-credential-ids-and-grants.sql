-- Credentials plan v4, PR 2: stable credential ids and one credential grant
-- type. Secret entries, OAuth integrations, and vault bindings get an `id`
-- the database assigns on insert; an MCP server's row id is already its
-- credential id. Name-keyed `secret` / `integration` grants and grant invites
-- (#3169) become `credential` grants keyed by that id, so a rename keeps the
-- grant and a deleted then recreated name does not inherit it. Encryption
-- contexts are untouched: nothing is re-encrypted.
--
-- Fails closed (nothing applies) when any name-keyed grant or grant invite,
-- live or revoked, maps to zero credentials or to more than one, or names a
-- vault door key or a package or session secret (that grant also covered
-- those, and one grant cannot become two ids without changing who can use
-- what). Grant and permission counts must match before and after.

DROP TABLE IF EXISTS __migration_assertions;
CREATE TABLE __migration_assertions (
	message TEXT NOT NULL CHECK (0)
);

-- 1. Stable ids on credential rows.
ALTER TABLE secret_entries ADD COLUMN id TEXT;
ALTER TABLE user_integrations ADD COLUMN id TEXT;
ALTER TABLE secret_provider_bindings ADD COLUMN id TEXT;

UPDATE secret_entries
SET id = lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4'
	|| substr(lower(hex(randomblob(2))), 2) || '-'
	|| substr('89ab', 1 + (random() & 3), 1)
	|| substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))
WHERE id IS NULL;

UPDATE user_integrations
SET id = lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4'
	|| substr(lower(hex(randomblob(2))), 2) || '-'
	|| substr('89ab', 1 + (random() & 3), 1)
	|| substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))
WHERE id IS NULL;

UPDATE secret_provider_bindings
SET id = lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4'
	|| substr(lower(hex(randomblob(2))), 2) || '-'
	|| substr('89ab', 1 + (random() & 3), 1)
	|| substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))
WHERE id IS NULL;

CREATE UNIQUE INDEX secret_entries_id ON secret_entries (id);
CREATE UNIQUE INDEX user_integrations_id ON user_integrations (id);
CREATE UNIQUE INDEX secret_provider_bindings_id ON secret_provider_bindings (id);

-- Inserts never pass an id; the database assigns it. An upsert that hits an
-- existing row keeps that row's id.
CREATE TRIGGER secret_entries_assign_id
AFTER INSERT ON secret_entries
WHEN NEW.id IS NULL
BEGIN
	UPDATE secret_entries
	SET id = lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4'
		|| substr(lower(hex(randomblob(2))), 2) || '-'
		|| substr('89ab', 1 + (random() & 3), 1)
		|| substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))
	WHERE rowid = NEW.rowid AND id IS NULL;
END;

CREATE TRIGGER user_integrations_assign_id
AFTER INSERT ON user_integrations
WHEN NEW.id IS NULL
BEGIN
	UPDATE user_integrations
	SET id = lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4'
		|| substr(lower(hex(randomblob(2))), 2) || '-'
		|| substr('89ab', 1 + (random() & 3), 1)
		|| substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))
	WHERE rowid = NEW.rowid AND id IS NULL;
END;

CREATE TRIGGER secret_provider_bindings_assign_id
AFTER INSERT ON secret_provider_bindings
WHEN NEW.id IS NULL
BEGIN
	UPDATE secret_provider_bindings
	SET id = lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4'
		|| substr(lower(hex(randomblob(2))), 2) || '-'
		|| substr('89ab', 1 + (random() & 3), 1)
		|| substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))
	WHERE rowid = NEW.rowid AND id IS NULL;
END;

INSERT INTO __migration_assertions (message)
SELECT 'a credential row has no id after the 0110 backfill; aborting.'
WHERE EXISTS (SELECT 1 FROM secret_entries WHERE id IS NULL)
	OR EXISTS (SELECT 1 FROM user_integrations WHERE id IS NULL)
	OR EXISTS (SELECT 1 FROM secret_provider_bindings WHERE id IS NULL)
	OR EXISTS (SELECT 1 FROM mcp_server_settings WHERE id IS NULL OR id = '');

-- 2. Map every name-keyed grant and grant invite to exactly one credential
-- in its org. Soft-deleted credential rows count: they keep their id. A
-- secret grant named the org-level secret (the `user` scope bucket).
DROP TABLE IF EXISTS __credential_name_candidates;
CREATE TABLE __credential_name_candidates (
	source TEXT NOT NULL CHECK (source IN ('grant', 'invite')),
	source_id TEXT NOT NULL,
	resource_type TEXT NOT NULL,
	credential_id TEXT NOT NULL
);

-- One INSERT per source: D1 caps the terms in a compound SELECT.
INSERT INTO __credential_name_candidates (source, source_id, resource_type, credential_id)
SELECT 'grant', g.id, g.resource_type, e.id
FROM grants g
JOIN secret_buckets b
	ON b.user_id = g.org_id AND b.scope = 'user' AND b.binding_key = ''
JOIN secret_entries e ON e.bucket_id = b.id AND e.name = g.resource_id
WHERE g.resource_type = 'secret';

INSERT INTO __credential_name_candidates (source, source_id, resource_type, credential_id)
SELECT 'grant', g.id, g.resource_type, ui.id
FROM grants g
JOIN user_integrations ui ON ui.user_id = g.org_id AND ui.name = g.resource_id
WHERE g.resource_type = 'integration';

INSERT INTO __credential_name_candidates (source, source_id, resource_type, credential_id)
SELECT 'grant', g.id, g.resource_type, s.id
FROM grants g
JOIN mcp_server_settings s ON s.user_id = g.org_id AND s.name = g.resource_id
WHERE g.resource_type = 'integration';

INSERT INTO __credential_name_candidates (source, source_id, resource_type, credential_id)
SELECT 'invite', i.id, i.resource_type, e.id
FROM invites i
JOIN secret_buckets b
	ON b.user_id = i.org_id AND b.scope = 'user' AND b.binding_key = ''
JOIN secret_entries e ON e.bucket_id = b.id AND e.name = i.resource_id
WHERE i.kind = 'grant' AND i.resource_type = 'secret';

INSERT INTO __credential_name_candidates (source, source_id, resource_type, credential_id)
SELECT 'invite', i.id, i.resource_type, ui.id
FROM invites i
JOIN user_integrations ui ON ui.user_id = i.org_id AND ui.name = i.resource_id
WHERE i.kind = 'grant' AND i.resource_type = 'integration';

INSERT INTO __credential_name_candidates (source, source_id, resource_type, credential_id)
SELECT 'invite', i.id, i.resource_type, s.id
FROM invites i
JOIN mcp_server_settings s ON s.user_id = i.org_id AND s.name = i.resource_id
WHERE i.kind = 'grant' AND i.resource_type = 'integration';

INSERT INTO __migration_assertions (message)
SELECT 'name-keyed credential grant ' || g.id || ' maps to no credential; aborting 0110.'
FROM grants g
WHERE g.resource_type IN ('secret', 'integration')
	AND NOT EXISTS (
		SELECT 1 FROM __credential_name_candidates c
		WHERE c.source = 'grant' AND c.source_id = g.id
	);

INSERT INTO __migration_assertions (message)
SELECT 'name-keyed credential invite ' || i.id || ' maps to no credential; aborting 0110.'
FROM invites i
WHERE i.kind = 'grant' AND i.resource_type IN ('secret', 'integration')
	AND NOT EXISTS (
		SELECT 1 FROM __credential_name_candidates c
		WHERE c.source = 'invite' AND c.source_id = i.id
	);

INSERT INTO __migration_assertions (message)
SELECT 'name-keyed credential ' || source || ' ' || source_id
	|| ' maps to more than one credential; aborting 0110.'
FROM __credential_name_candidates
GROUP BY source, source_id
HAVING COUNT(*) > 1;

INSERT INTO __migration_assertions (message)
SELECT 'name-keyed secret grant ' || g.id || ' names a vault door key; aborting 0110.'
FROM grants g
JOIN secret_provider_bindings p
	ON p.user_id = g.org_id AND p.door_secret_name = g.resource_id
WHERE g.resource_type = 'secret';

INSERT INTO __migration_assertions (message)
SELECT 'name-keyed secret invite ' || i.id || ' names a vault door key; aborting 0110.'
FROM invites i
JOIN secret_provider_bindings p
	ON p.user_id = i.org_id AND p.door_secret_name = i.resource_id
WHERE i.kind = 'grant' AND i.resource_type = 'secret';

-- Resolution prefers a package or session secret over the org secret of the
-- same name, so the name grant covered that secret too.
INSERT INTO __migration_assertions (message)
SELECT 'name-keyed secret grant ' || g.id
	|| ' also covers a package or session secret; aborting 0110.'
FROM grants g
WHERE g.resource_type = 'secret'
	AND EXISTS (
		SELECT 1 FROM secret_entries e
		JOIN secret_buckets b ON b.id = e.bucket_id
		WHERE b.user_id = g.org_id AND NOT (b.scope = 'user' AND b.binding_key = '')
			AND e.name = g.resource_id
	);

INSERT INTO __migration_assertions (message)
SELECT 'name-keyed secret invite ' || i.id
	|| ' also covers a package or session secret; aborting 0110.'
FROM invites i
WHERE i.kind = 'grant' AND i.resource_type = 'secret'
	AND EXISTS (
		SELECT 1 FROM secret_entries e
		JOIN secret_buckets b ON b.id = e.bucket_id
		WHERE b.user_id = i.org_id AND NOT (b.scope = 'user' AND b.binding_key = '')
			AND e.name = i.resource_id
	);

-- 3. Counts before the rewrite.
DROP TABLE IF EXISTS __credential_grant_counts;
CREATE TABLE __credential_grant_counts (
	phase TEXT PRIMARY KEY NOT NULL CHECK (phase IN ('before', 'after')),
	grants INTEGER NOT NULL,
	live_grants INTEGER NOT NULL,
	grant_permissions INTEGER NOT NULL,
	credential_grants INTEGER NOT NULL,
	grant_invites INTEGER NOT NULL,
	credential_invites INTEGER NOT NULL
);

INSERT INTO __credential_grant_counts
SELECT 'before',
	(SELECT COUNT(*) FROM grants),
	(SELECT COUNT(*) FROM grants WHERE deleted_at IS NULL),
	(SELECT COUNT(*) FROM grant_permissions),
	(SELECT COUNT(*) FROM grants WHERE resource_type IN ('secret', 'integration')),
	(SELECT COUNT(*) FROM invites WHERE kind = 'grant'),
	(SELECT COUNT(*) FROM invites
		WHERE kind = 'grant' AND resource_type IN ('secret', 'integration'));

-- 4. Rebuild grants with the credential resource type. Grant ids and
-- grant_permissions rows are unchanged.
CREATE TABLE grants_next (
	id TEXT PRIMARY KEY NOT NULL,
	org_id TEXT NOT NULL,
	resource_type TEXT NOT NULL CHECK (
		resource_type IN (
			'package',
			'app',
			'job',
			'credential',
			'memory',
			'email',
			'org'
		)
	),
	resource_id TEXT NOT NULL,
	subject_type TEXT NOT NULL CHECK (subject_type IN ('user', 'team')),
	subject_id TEXT NOT NULL,
	preset TEXT CHECK (preset IN ('use', 'contribute', 'manage')),
	created_by_user_id TEXT NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	deleted_at TEXT
);

INSERT INTO grants_next (
	id, org_id, resource_type, resource_id, subject_type, subject_id,
	preset, created_by_user_id, created_at, updated_at, deleted_at
)
SELECT g.id, g.org_id,
	CASE WHEN c.credential_id IS NULL THEN g.resource_type ELSE 'credential' END,
	COALESCE(c.credential_id, g.resource_id),
	g.subject_type, g.subject_id, g.preset, g.created_by_user_id,
	g.created_at, g.updated_at, g.deleted_at
FROM grants g
LEFT JOIN __credential_name_candidates c
	ON c.source = 'grant' AND c.source_id = g.id;

DROP TABLE grants;
ALTER TABLE grants_next RENAME TO grants;

CREATE UNIQUE INDEX grants_live_subject ON grants (
	resource_type,
	resource_id,
	subject_type,
	subject_id
) WHERE deleted_at IS NULL;

CREATE INDEX grants_subject ON grants (subject_type, subject_id)
	WHERE deleted_at IS NULL;

UPDATE invites
SET resource_type = 'credential',
	resource_id = (
		SELECT c.credential_id FROM __credential_name_candidates c
		WHERE c.source = 'invite' AND c.source_id = invites.id
	)
WHERE kind = 'grant' AND resource_type IN ('secret', 'integration');

-- Compiled access keyed grants by name; recompile every org that had one.
UPDATE orgs
SET access_epoch = access_epoch + 1
WHERE id IN (
	SELECT g.org_id FROM grants g WHERE g.resource_type = 'credential'
);

-- 5. Counts after the rewrite must match.
INSERT INTO __credential_grant_counts
SELECT 'after',
	(SELECT COUNT(*) FROM grants),
	(SELECT COUNT(*) FROM grants WHERE deleted_at IS NULL),
	(SELECT COUNT(*) FROM grant_permissions),
	(SELECT COUNT(*) FROM grants WHERE resource_type = 'credential'),
	(SELECT COUNT(*) FROM invites WHERE kind = 'grant'),
	(SELECT COUNT(*) FROM invites
		WHERE kind = 'grant' AND resource_type = 'credential');

INSERT INTO __migration_assertions (message)
SELECT 'grant counts changed in 0110; aborting.'
FROM __credential_grant_counts before_counts
JOIN __credential_grant_counts after_counts
	ON before_counts.phase = 'before' AND after_counts.phase = 'after'
WHERE before_counts.grants != after_counts.grants
	OR before_counts.live_grants != after_counts.live_grants
	OR before_counts.grant_permissions != after_counts.grant_permissions
	OR before_counts.credential_grants != after_counts.credential_grants
	OR before_counts.grant_invites != after_counts.grant_invites
	OR before_counts.credential_invites != after_counts.credential_invites;

INSERT INTO __migration_assertions (message)
SELECT 'a name-keyed credential grant or invite remains after 0110; aborting.'
WHERE EXISTS (
	SELECT 1 FROM grants WHERE resource_type IN ('secret', 'integration')
) OR EXISTS (
	SELECT 1 FROM invites
	WHERE kind = 'grant' AND resource_type IN ('secret', 'integration')
);

-- 6. An enablement paused on a credential keeps the credential's family and
-- name in paused_resource_type / paused_resource_id (what people read) and
-- its stable id here (what the resume check uses). Rows paused before this
-- migration have no id and resolve their stored name on the next check.
ALTER TABLE enablements ADD COLUMN paused_credential_id TEXT;

DROP TABLE __credential_grant_counts;
DROP TABLE __credential_name_candidates;
DROP TABLE __migration_assertions;
