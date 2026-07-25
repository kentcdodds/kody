-- Idempotency ledger for Stripe platform-billing webhook deliveries.
-- Stores processed Stripe event ids so redeliveries are acknowledged without
-- re-running link/refresh side effects.
CREATE TABLE IF NOT EXISTS stripe_webhook_events (
	event_id TEXT PRIMARY KEY NOT NULL,
	event_type TEXT NOT NULL,
	processed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_stripe_webhook_events_processed_at
ON stripe_webhook_events(processed_at);
