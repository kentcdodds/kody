-- Lookup path for package secret access: self-authored packages have no
-- community_forks row; forked packages are found by forked_package_id.
CREATE INDEX IF NOT EXISTS idx_community_forks_forked_package_id
ON community_forks(forked_package_id);
