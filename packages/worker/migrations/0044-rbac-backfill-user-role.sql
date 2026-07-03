-- Accounts created before RBAC (migration 0043) never went through the
-- signup path that assigns the default `user` role. Backfill it for every
-- existing account; INSERT OR IGNORE keeps this idempotent.
INSERT OR IGNORE INTO user_roles (user_id, role_id)
SELECT u.id, r.id
FROM users u
CROSS JOIN roles r
WHERE r.name = 'user';
