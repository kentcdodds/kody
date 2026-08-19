-- Move onboarding checklist dismissal off leftover user values.
-- Backfill from onboardingChecklistDismissed, then delete those user-scope rows.
-- Session/app leftover rows stay intact. The stored value is an ISO timestamp;
-- fall back to the row's updated_at.

ALTER TABLE users ADD COLUMN onboarding_checklist_dismissed_at TEXT;

UPDATE users
SET onboarding_checklist_dismissed_at = (
	SELECT COALESCE(NULLIF(TRIM(ve.value), ''), ve.updated_at)
	FROM value_buckets vb
	INNER JOIN value_entries ve ON ve.bucket_id = vb.id
	WHERE vb.user_id = users.stable_user_id
		AND vb.scope = 'user'
		AND ve.name = 'onboardingChecklistDismissed'
	LIMIT 1
)
WHERE onboarding_checklist_dismissed_at IS NULL
	AND EXISTS (
		SELECT 1
		FROM value_buckets vb
		INNER JOIN value_entries ve ON ve.bucket_id = vb.id
		WHERE vb.user_id = users.stable_user_id
			AND vb.scope = 'user'
			AND ve.name = 'onboardingChecklistDismissed'
	);

DELETE FROM value_entries
WHERE name = 'onboardingChecklistDismissed'
	AND bucket_id IN (
		SELECT id
		FROM value_buckets
		WHERE scope = 'user'
	);
