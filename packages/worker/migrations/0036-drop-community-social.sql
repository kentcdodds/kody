-- Hard-cut the community social graph. Follows, listing bookmark stars, and
-- the surfaces that read them are gone; public catalog listings and
-- /@username profile catalogs remain.
DROP INDEX IF EXISTS idx_community_stars_user_id;
DROP INDEX IF EXISTS idx_user_follows_followee_user_id;
DROP TABLE IF EXISTS community_stars;
DROP TABLE IF EXISTS user_follows;
