-- ADR 0074: one inbox address per org, packages only through per-sender
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

-- One live row per org, package instance, and topic. A second live
-- personal-org subscription of the same topic stays sender_kind NULL (it
-- matches no sender) so this backfill can create the unique index below.
UPDATE enablements
SET sender_kind = 'any_authenticated'
WHERE id IN (
	SELECT id FROM (
		SELECT e.id AS id
		FROM enablements e
		WHERE e.sender_kind IS NULL
			AND e.state <> 'off'
			AND e.trigger_kind = 'subscription'
			AND e.trigger_name IN (
				'email.message.received',
				'email.message.quarantined'
			)
			AND EXISTS (
				SELECT 1 FROM users u
				WHERE u.stable_user_id = e.org_id
					AND u.deleted_at IS NULL
			)
			AND e.id = (
				SELECT e2.id
				FROM enablements e2
				WHERE e2.org_id = e.org_id
					AND e2.instance_id = e.instance_id
					AND e2.trigger_name = e.trigger_name
					AND e2.state <> 'off'
					AND e2.trigger_kind = 'subscription'
					AND e2.trigger_name IN (
						'email.message.received',
						'email.message.quarantined'
					)
				ORDER BY e2.enabled_at, e2.id
				LIMIT 1
			)
	)
);

-- Live subscription enablements by org, instance, and sender. Inbound
-- dispatch lists one instance, then matches the sender in process.
CREATE INDEX IF NOT EXISTS enablements_subscription_sender
	ON enablements (org_id, instance_id, sender_kind, sender_value)
	WHERE state <> 'off' AND trigger_kind = 'subscription';

-- One live inbound-email rule per org, package instance, topic, and sender.
-- Concurrent approvals of the same sender cannot both insert.
CREATE UNIQUE INDEX IF NOT EXISTS enablements_email_sender_one_live
	ON enablements (
		org_id,
		instance_id,
		trigger_name,
		sender_kind,
		IFNULL(sender_value, '')
	)
	WHERE state <> 'off'
		AND trigger_kind = 'subscription'
		AND trigger_name IN (
			'email.message.received',
			'email.message.quarantined'
		)
		AND sender_kind IS NOT NULL;
