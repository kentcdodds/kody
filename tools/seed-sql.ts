import { createHash } from 'node:crypto'
import { quoteSqlString } from '@kody-internal/shared/sql-literals.ts'

/**
 * SQL builders shared by the seeding CLI (`tools/seed-test-data.ts`), the E2E
 * D1 helpers (`e2e/d1-utils.ts`), and the MCP test support harness, so the
 * user/role seeding statements cannot drift between them.
 */

/**
 * Node-sync equivalent of the worker's `createStableUserIdFromEmail`
 * (`packages/worker/src/user-id.ts`): sha256 hex of the trimmed lowercase
 * email. Seeded users must carry the same derived id as the signup path so
 * fixtures match production identity semantics.
 */
export function stableUserIdFromEmail(email: string) {
	return createHash('sha256').update(email.trim().toLowerCase()).digest('hex')
}

export function buildRoleAssignmentSql(input: { email: string; role: string }) {
	return `
INSERT OR IGNORE INTO user_roles (user_id, role_id)
SELECT u.id, r.id
FROM users u, roles r
WHERE u.email = ${quoteSqlString(input.email)} AND r.name = ${quoteSqlString(input.role)};`.trim()
}

export function buildSeedUserSql(input: {
	email: string
	username: string
	passwordHash: string
	admin?: boolean
}) {
	const roleSql = [
		buildRoleAssignmentSql({ email: input.email, role: 'user' }),
		...(input.admin
			? [buildRoleAssignmentSql({ email: input.email, role: 'admin' })]
			: []),
	].join('\n')

	return `
INSERT INTO users (username, email, password_hash, email_verified_at, stable_user_id, plan)
VALUES (${quoteSqlString(input.username)}, ${quoteSqlString(input.email)}, ${quoteSqlString(input.passwordHash)}, CURRENT_TIMESTAMP, ${quoteSqlString(stableUserIdFromEmail(input.email))}, 'unlimited')
ON CONFLICT(email) DO UPDATE SET
  username = excluded.username,
  password_hash = excluded.password_hash,
  email_verified_at = COALESCE(users.email_verified_at, excluded.email_verified_at),
  stable_user_id = COALESCE(users.stable_user_id, excluded.stable_user_id),
  plan = COALESCE(users.plan, excluded.plan),
  updated_at = CURRENT_TIMESTAMP;
${roleSql}`.trim()
}
