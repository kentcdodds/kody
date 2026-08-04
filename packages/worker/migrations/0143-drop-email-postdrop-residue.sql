DROP TABLE IF EXISTS email_user_graph_drop_approval;
DROP TABLE IF EXISTS email_inbound_usage_effects;

DROP INDEX IF EXISTS idx_email_inbound_due_owners_priority_due_at;
CREATE INDEX idx_email_inbound_due_owners_priority_due_at
	ON email_inbound_due_owners(due_at, user_id);
