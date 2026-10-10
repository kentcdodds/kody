-- Teams P9 contract: drop leftover share and scope-grant tables after the P8
-- soak. Live access already uses org grants and Owner memberships (#3082,
-- #3083). trust_level / accepted_published_commit lived only on
-- package_share_grants and go away with that table.

DROP INDEX IF EXISTS idx_package_share_grants_active_grantee;
DROP INDEX IF EXISTS idx_package_share_grants_active_email;
DROP INDEX IF EXISTS idx_package_share_grants_invitee_email;
DROP INDEX IF EXISTS idx_package_share_grants_grantee_user_id;
DROP INDEX IF EXISTS idx_package_share_grants_owner_user_id;
DROP INDEX IF EXISTS idx_package_share_grants_package_id;
DROP TABLE IF EXISTS package_share_grants;

DROP INDEX IF EXISTS idx_package_scope_grants_grantee_user_id;
DROP TABLE IF EXISTS package_scope_grants;
