-- Stored credential mappings (ADR 0068 amendment 2026-10-13): the credentials
-- one package need resolves to. One row per need per target:
--   org         the package's org-layer default (person_user_id and enablement_id '')
--   mine        one person's own default (person_user_id set)
--   enablement  one trigger instance's override (enablement_id set; person_user_id
--               is the enabler, so deleting the person drops their overrides)
-- credential_ids_json is an ordered JSON array of credential ids; '[]' means
-- "none on purpose". Rows hold ids only, never values.

CREATE TABLE credential_mappings (
	id TEXT PRIMARY KEY NOT NULL,
	org_id TEXT NOT NULL,
	package_id TEXT NOT NULL,
	need_key TEXT NOT NULL,
	target TEXT NOT NULL CHECK (target IN ('org', 'mine', 'enablement')),
	person_user_id TEXT NOT NULL DEFAULT '',
	enablement_id TEXT NOT NULL DEFAULT '',
	credential_ids_json TEXT NOT NULL DEFAULT '[]',
	updated_by_user_id TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	CHECK (
		(target = 'org' AND person_user_id = '' AND enablement_id = '')
		OR (target = 'mine' AND person_user_id <> '' AND enablement_id = '')
		OR (target = 'enablement' AND person_user_id <> '' AND enablement_id <> '')
	)
);

CREATE UNIQUE INDEX credential_mappings_target_need_idx
	ON credential_mappings (
		org_id, package_id, target, person_user_id, enablement_id, need_key
	);

CREATE INDEX credential_mappings_person_user_idx
	ON credential_mappings (person_user_id)
	WHERE person_user_id <> '';
