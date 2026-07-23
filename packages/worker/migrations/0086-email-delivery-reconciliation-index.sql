-- Scheduled inbound reconciliation filters globally by provider/event type
-- before applying JSON state predicates.
CREATE INDEX IF NOT EXISTS idx_email_delivery_events_provider_event_created_at
ON email_delivery_events(provider, event_type, created_at);
