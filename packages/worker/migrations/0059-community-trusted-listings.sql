-- Admin-curated trust marks for community listings. Trust is pinned to the
-- listing commit that was reviewed: a listing is effectively trusted only
-- while trusted_commit matches pinned_commit, so an owner republish
-- automatically drops the mark until an admin re-reviews.
ALTER TABLE community_listings ADD COLUMN trusted_commit TEXT;
ALTER TABLE community_listings ADD COLUMN trusted_by_user_id TEXT;
ALTER TABLE community_listings ADD COLUMN trusted_at TEXT;
