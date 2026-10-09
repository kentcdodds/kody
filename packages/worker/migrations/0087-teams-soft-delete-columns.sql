-- Teams P3 expand: additive deleted_at / deleting_at on org-owned resources and
-- users. The enforced read filter and purge lane land in P7; columns only here.

ALTER TABLE users ADD COLUMN deleted_at TEXT;

ALTER TABLE saved_packages ADD COLUMN deleted_at TEXT;
ALTER TABLE saved_packages ADD COLUMN deleting_at TEXT;

ALTER TABLE user_repos ADD COLUMN deleted_at TEXT;
ALTER TABLE user_repos ADD COLUMN deleting_at TEXT;

ALTER TABLE webhook_endpoints ADD COLUMN deleted_at TEXT;
ALTER TABLE webhook_endpoints ADD COLUMN deleting_at TEXT;

ALTER TABLE secret_buckets ADD COLUMN deleted_at TEXT;
ALTER TABLE secret_buckets ADD COLUMN deleting_at TEXT;

ALTER TABLE secret_entries ADD COLUMN deleted_at TEXT;
ALTER TABLE secret_entries ADD COLUMN deleting_at TEXT;

ALTER TABLE secret_provider_bindings ADD COLUMN deleted_at TEXT;
ALTER TABLE secret_provider_bindings ADD COLUMN deleting_at TEXT;

ALTER TABLE value_buckets ADD COLUMN deleted_at TEXT;
ALTER TABLE value_buckets ADD COLUMN deleting_at TEXT;

ALTER TABLE value_entries ADD COLUMN deleted_at TEXT;
ALTER TABLE value_entries ADD COLUMN deleting_at TEXT;

ALTER TABLE user_storage_buckets ADD COLUMN deleted_at TEXT;
ALTER TABLE user_storage_buckets ADD COLUMN deleting_at TEXT;

ALTER TABLE user_integrations ADD COLUMN deleted_at TEXT;
ALTER TABLE user_integrations ADD COLUMN deleting_at TEXT;

ALTER TABLE user_oauth_apps ADD COLUMN deleted_at TEXT;
ALTER TABLE user_oauth_apps ADD COLUMN deleting_at TEXT;

ALTER TABLE mcp_server_settings ADD COLUMN deleted_at TEXT;
ALTER TABLE mcp_server_settings ADD COLUMN deleting_at TEXT;

ALTER TABLE mcp_memories ADD COLUMN deleted_at TEXT;
ALTER TABLE mcp_memories ADD COLUMN deleting_at TEXT;

ALTER TABLE mcp_user_server_instructions ADD COLUMN deleted_at TEXT;
ALTER TABLE mcp_user_server_instructions ADD COLUMN deleting_at TEXT;

ALTER TABLE mcp_event_subscriptions ADD COLUMN deleted_at TEXT;
ALTER TABLE mcp_event_subscriptions ADD COLUMN deleting_at TEXT;

ALTER TABLE email_inboxes ADD COLUMN deleted_at TEXT;
ALTER TABLE email_inboxes ADD COLUMN deleting_at TEXT;

ALTER TABLE email_inbox_addresses ADD COLUMN deleted_at TEXT;
ALTER TABLE email_inbox_addresses ADD COLUMN deleting_at TEXT;

ALTER TABLE email_sender_rules ADD COLUMN deleted_at TEXT;
ALTER TABLE email_sender_rules ADD COLUMN deleting_at TEXT;

ALTER TABLE email_sender_identities ADD COLUMN deleted_at TEXT;
ALTER TABLE email_sender_identities ADD COLUMN deleting_at TEXT;

ALTER TABLE email_notification_destinations ADD COLUMN deleted_at TEXT;
ALTER TABLE email_notification_destinations ADD COLUMN deleting_at TEXT;

ALTER TABLE connection_profiles ADD COLUMN deleted_at TEXT;
ALTER TABLE connection_profiles ADD COLUMN deleting_at TEXT;

ALTER TABLE entity_sources ADD COLUMN deleted_at TEXT;
ALTER TABLE entity_sources ADD COLUMN deleting_at TEXT;

ALTER TABLE community_listings ADD COLUMN deleted_at TEXT;
ALTER TABLE community_listings ADD COLUMN deleting_at TEXT;

ALTER TABLE api_tokens ADD COLUMN deleted_at TEXT;
ALTER TABLE api_tokens ADD COLUMN deleting_at TEXT;
