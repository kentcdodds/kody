-- Cross-isolate OAuth refresh lease. A refresher claims the lease with a
-- compare-and-swap on `token_refreshed_at` before reading the refresh token,
-- so rotating providers see one refresh per connection at a time. An expired
-- lease (holder crashed) is reclaimable; NULL means no refresh in flight.
ALTER TABLE user_integrations ADD COLUMN token_refresh_lease_id TEXT;
ALTER TABLE user_integrations ADD COLUMN token_refresh_lease_expires_at TEXT;
