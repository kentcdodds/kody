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
VALUES (${quoteSqlString(input.username)}, ${quoteSqlString(input.email)}, ${quoteSqlString(input.passwordHash)}, CURRENT_TIMESTAMP, ${quoteSqlString(stableUserIdFromEmail(input.email))}, 'free')
ON CONFLICT(email) DO UPDATE SET
  username = excluded.username,
  password_hash = excluded.password_hash,
  email_verified_at = COALESCE(users.email_verified_at, excluded.email_verified_at),
  stable_user_id = COALESCE(users.stable_user_id, excluded.stable_user_id),
  plan = COALESCE(users.plan, excluded.plan),
  updated_at = CURRENT_TIMESTAMP;
${roleSql}`.trim()
}

/**
 * A user-lane Google app with two connected accounts so /account/integrations
 * can exercise Disconnect and Delete integration without a live OAuth dance.
 */
export function buildSeedIntegrationSql(email: string) {
	const userId = quoteSqlString(stableUserIdFromEmail(email))
	return `
INSERT INTO user_oauth_apps (
	user_id, slug, provider, label, client_id, client_secret_secret_name,
	token_url, authorize_url, api_base_url, flow, extra_authorize_params_json
) VALUES (
	${userId}, 'google', 'google', 'Google', 'seed-google-client',
	'googleClientSecret',
	'https://oauth2.googleapis.com/token',
	'https://accounts.google.com/o/oauth2/v2/auth',
	'https://www.googleapis.com',
	'pkce', '{}'
)
ON CONFLICT(user_id, slug) DO UPDATE SET
	label = excluded.label,
	client_id = excluded.client_id,
	updated_at = CURRENT_TIMESTAMP;
INSERT INTO user_integrations (
	user_id, name, app_slug, platform_app_slug, account_label, description,
	scopes_json, required_hosts_json, access_token_secret_name,
	refresh_token_secret_name, connected_at
) VALUES
	(
		${userId}, 'google', 'google', NULL, 'Personal', '',
		'["openid","email"]', '["www.googleapis.com"]',
		'googleAccessToken', 'googleRefreshToken', CURRENT_TIMESTAMP
	),
	(
		${userId}, 'google-work', 'google', NULL, 'Work', '',
		'["openid","email"]', '["www.googleapis.com"]',
		'googleWorkAccessToken', 'googleWorkRefreshToken', CURRENT_TIMESTAMP
	)
ON CONFLICT(user_id, name) DO UPDATE SET
	account_label = excluded.account_label,
	app_slug = excluded.app_slug,
	updated_at = CURRENT_TIMESTAMP;`.trim()
}
