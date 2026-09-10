-- Indexed columns for admin launch-signal aggregations. The insights page
-- groups paid Stripe prices, first-touch MCP clients, signup/created_at
-- windows, and last_active_at activity without paging the user table.

CREATE INDEX IF NOT EXISTS idx_users_created_at
	ON users(created_at);

CREATE INDEX IF NOT EXISTS idx_users_last_active_at
	ON users(last_active_at)
	WHERE last_active_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_users_stripe_plan_price
	ON users(stripe_plan, stripe_price_id)
	WHERE stripe_plan IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_users_mcp_client_name
	ON users(mcp_client_name)
	WHERE first_mcp_connected_at IS NOT NULL;
