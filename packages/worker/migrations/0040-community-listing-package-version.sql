-- Author-supplied package.json#version for catalog display. Null when the
-- author omitted it or the listing predates this column. Not a platform
-- versioning contract — listings stay identified by pinned_commit.
ALTER TABLE community_listings
ADD COLUMN package_version TEXT;
