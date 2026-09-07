-- Durable opt-out for Kody tips (usage-state campaign mail only).
-- Transactional verify / billing / error-rate mail is never gated by this.

ALTER TABLE users ADD COLUMN tips_emails_opted_out_at TEXT;
