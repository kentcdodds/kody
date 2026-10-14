-- A bundle decision row is written as a claim before its approve or deny
-- runs, so only one request acts on an item. `finalized_at` is set once the
-- approve or deny is done; until then the row is an in-flight claim, not a
-- decision. A claim left behind by a request that stopped part-way expires
-- and can be taken over, so the item is never stuck looking decided.

ALTER TABLE approval_bundle_decisions ADD COLUMN finalized_at TEXT;

UPDATE approval_bundle_decisions SET finalized_at = decided_at
WHERE finalized_at IS NULL;
