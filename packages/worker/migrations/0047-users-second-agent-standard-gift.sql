-- One-time 14-day Standard gift when a user first reaches two unique inbound
-- MCP OAuth clientIds. granted_at is the idempotency ledger (one gift per
-- user). expires_at is set only when the gift actually overlays Standard;
-- NULL means the account was already Standard/Pro/max so Stripe was not
-- touched.

ALTER TABLE users ADD COLUMN second_agent_standard_gift_granted_at TEXT;
ALTER TABLE users ADD COLUMN second_agent_standard_gift_expires_at TEXT;
