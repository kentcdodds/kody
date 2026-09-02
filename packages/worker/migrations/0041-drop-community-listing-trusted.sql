-- Product no longer has trusted listings. Reads hardcode trusted: false and
-- inserts omit these columns. Featured is independent (featured_at IS NOT NULL).
ALTER TABLE community_listings DROP COLUMN trusted_commit;
ALTER TABLE community_listings DROP COLUMN trusted_by_user_id;
ALTER TABLE community_listings DROP COLUMN trusted_at;
