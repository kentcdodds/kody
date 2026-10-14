-- ADR 0073: one inbox address per org, packages only through per-sender
-- enablement rows. NULL sender_kind matches no inbound sender, so unmatched
-- mail stays in the admin inbox. There is no blanket switch.
--
-- Personal orgs (a live users.stable_user_id) keep existing email
-- subscriptions firing. The UI offers narrowing for any_authenticated
-- catch-alls from this migration. Team orgs are not backfilled; they start
-- with no sender rules.

ALTER TABLE enablements ADD COLUMN sender_kind TEXT CHECK (
	sender_kind IS NULL
	OR sender_kind IN ('member', 'address', 'domain', 'any_authenticated')
);

ALTER TABLE enablements ADD COLUMN sender_value TEXT;

UPDATE enablements
SET sender_kind = 'any_authenticated'
WHERE sender_kind IS NULL
	AND state <> 'off'
	AND trigger_kind = 'subscription'
	AND trigger_name IN (
		'email.message.received',
		'email.message.quarantined'
	)
	AND EXISTS (
		SELECT 1 FROM users u
		WHERE u.stable_user_id = enablements.org_id
			AND u.deleted_at IS NULL
	);

-- Live subscription enablements by org, instance, and sender. Inbound
-- dispatch lists one instance, then matches the sender in process.
CREATE INDEX IF NOT EXISTS enablements_subscription_sender
	ON enablements (org_id, instance_id, sender_kind, sender_value)
	WHERE state <> 'off' AND trigger_kind = 'subscription';
