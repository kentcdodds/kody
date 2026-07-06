-- System inboxes receive mail for operator-owned reserved local parts (for
-- example kody@, abuse@, and postmaster@). Their receive caps are deployment
-- constants rather than user plan entitlements, so their daily counter is kept
-- separate from entitlement_daily_counters.
CREATE TABLE IF NOT EXISTS system_email_daily_counters (
	local_part TEXT NOT NULL,
	day TEXT NOT NULL,
	count INTEGER NOT NULL DEFAULT 0,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (local_part, day)
);
