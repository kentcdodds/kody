-- Admin-curated featured marks for community listings. Featured listings are
-- highlighted during onboarding as one-click-install starter packages. A
-- listing is only effectively featured while it is also effectively trusted
-- (trusted_commit matches pinned_commit), so an owner republish silently
-- pulls it from onboarding until an admin re-reviews and re-trusts it.
ALTER TABLE community_listings ADD COLUMN featured_at TEXT;
