-- At most one non-off enablement per webhook instance. Cron and subscription
-- keep allowing several. Additive: does not alter existing rows. If an
-- environment already has duplicate live webhook enablements, creating this
-- index fails until those are cleaned by hand — do not DELETE them in this
-- migration.
CREATE UNIQUE INDEX IF NOT EXISTS enablements_webhook_one_live
	ON enablements (org_id, instance_id)
	WHERE trigger_kind = 'webhook' AND state <> 'off';
