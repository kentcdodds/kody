-- ADR 0074: one inbox address per org, packages only through per-sender
-- enablement rows. NULL sender_kind matches no inbound sender, so unmatched
-- mail stays in the admin inbox. There is no blanket switch.
--
-- Personal orgs (a live users.stable_user_id) keep existing email
-- subscriptions firing. Those catch-alls are tagged origin = 'migrated' so
-- the UI can offer narrowing. Team orgs are not backfilled; they start with
-- no sender rules.

ALTER TABLE enablements ADD COLUMN sender_kind TEXT CHECK (
	sender_kind IS NULL
	OR sender_kind IN ('member', 'address', 'domain', 'any_authenticated')
);

ALTER TABLE enablements ADD COLUMN sender_value TEXT;

-- One live row per org, package instance, and topic. Prefer an already
-- migrated live row, else an `on` row, so a paused or older sibling does not
-- steal the catch-all. A second live personal-org subscription of the same
-- topic stays sender_kind NULL (it matches no sender) so the unique sender
-- index below can be created.
--
-- enablements_migrated_instance allows only one origin=migrated row per
-- org/instance/topic (including off leftovers from an earlier backfill).
-- Release that slot from non-chosen siblings before tagging the catch-all.

UPDATE enablements
SET origin = 'enabled'
WHERE origin = 'migrated'
	AND id NOT IN (
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
					ORDER BY CASE WHEN e2.origin = 'migrated' THEN 0 ELSE 1 END,
						CASE WHEN e2.state = 'on' THEN 0 ELSE 1 END,
						e2.enabled_at,
						e2.id
					LIMIT 1
				)
		)
	)
	AND EXISTS (
		SELECT 1 FROM (
			SELECT e.org_id AS org_id,
				e.instance_id AS instance_id,
				e.trigger_name AS trigger_name
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
					ORDER BY CASE WHEN e2.origin = 'migrated' THEN 0 ELSE 1 END,
						CASE WHEN e2.state = 'on' THEN 0 ELSE 1 END,
						e2.enabled_at,
						e2.id
					LIMIT 1
				)
		) chosen
		WHERE chosen.org_id = enablements.org_id
			AND chosen.instance_id = enablements.instance_id
			AND chosen.trigger_name = enablements.trigger_name
	);

UPDATE enablements
SET sender_kind = 'any_authenticated',
	origin = 'migrated'
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
				ORDER BY CASE WHEN e2.origin = 'migrated' THEN 0 ELSE 1 END,
					CASE WHEN e2.state = 'on' THEN 0 ELSE 1 END,
					e2.enabled_at,
					e2.id
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
