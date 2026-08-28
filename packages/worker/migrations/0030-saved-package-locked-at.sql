-- Website-gated publish lock. NULL means publishes may proceed; a timestamp
-- means agent/reconcile promote is blocked until the owner approves a commit
-- in the account UI. Unlocking is website-only.
ALTER TABLE saved_packages
ADD COLUMN locked_at TEXT;
