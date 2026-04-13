PRAGMA defer_foreign_keys = ON;

CREATE TABLE ui_artifacts_v2 (
	id TEXT PRIMARY KEY NOT NULL,
	user_id TEXT NOT NULL,
	title TEXT NOT NULL,
	description TEXT NOT NULL,
	client_code TEXT NOT NULL,
	server_code TEXT,
	server_code_id TEXT NOT NULL,
	parameters TEXT,
	hidden INTEGER NOT NULL DEFAULT 1,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

INSERT INTO ui_artifacts_v2 (
	id,
	user_id,
	title,
	description,
	client_code,
	server_code,
	server_code_id,
	parameters,
	hidden,
	created_at,
	updated_at
)
SELECT
	id,
	user_id,
	title,
	description,
	CASE
		WHEN source_type = 'html' THEN source_code
		WHEN source_type = 'javascript' THEN
			'<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
	</head>
	<body data-kody-runtime="javascript">
		<div id="app" data-generated-ui-root></div>
		<script type="module">
' || replace(source_code, '</script', '<\/script') || '
		</script>
	</body>
</html>'
		ELSE ''
	END AS client_code,
	NULL AS server_code,
	lower(hex(randomblob(16))) AS server_code_id,
	parameters,
	hidden,
	created_at,
	updated_at
FROM ui_artifacts;

DROP TABLE ui_artifacts;

ALTER TABLE ui_artifacts_v2 RENAME TO ui_artifacts;

CREATE INDEX idx_ui_artifacts_user_id ON ui_artifacts(user_id);

PRAGMA defer_foreign_keys = OFF;
