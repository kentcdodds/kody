import { createHash } from 'node:crypto'
import { quoteSqlString } from '@kody-internal/shared/sql-literals.ts'
import { type FeatureFlagKey } from '#universal/feature-flags/registry.ts'

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

/**
 * Deterministic TEXT ids for local metadata-only seed packages (and their
 * unique `source_id` values) so re-seeding upserts the same rows.
 */
export function seedSavedPackageIds(input: { email: string; index: number }): {
	packageId: string
	sourceId: string
} {
	const userId = stableUserIdFromEmail(input.email)
	const packageId = createHash('sha256')
		.update(`seed-saved-package:${userId}:${input.index}`)
		.digest('hex')
	const sourceId = createHash('sha256')
		.update(`seed-saved-package-source:${userId}:${input.index}`)
		.digest('hex')
	return { packageId, sourceId }
}

/**
 * Metadata-only `saved_packages` rows for local UI fixtures. No
 * `entity_sources`, artifacts, or ARTIFACTS binding — enough for account
 * pickers that list packages by `user_id`.
 */
export function buildSeedSavedPackagesSql(input: {
	email: string
	count: number
}) {
	const userId = quoteSqlString(stableUserIdFromEmail(input.email))
	const statements: Array<string> = []
	for (let index = 1; index <= input.count; index += 1) {
		const { packageId, sourceId } = seedSavedPackageIds({
			email: input.email,
			index,
		})
		const name = `seed-pkg-${index}`
		const description = `Local seed metadata-only package ${index}`
		statements.push(
			`
INSERT INTO saved_packages (
	id, user_id, name, kody_id, description, tags_json, search_text,
	source_id, has_app, hidden, is_private
) VALUES (
	${quoteSqlString(packageId)}, ${userId}, ${quoteSqlString(name)},
	${quoteSqlString(name)}, ${quoteSqlString(description)}, '[]',
	${quoteSqlString(`${name} ${description}`)}, ${quoteSqlString(sourceId)},
	0, 0, 1
)
ON CONFLICT(id) DO UPDATE SET
	name = excluded.name,
	kody_id = excluded.kody_id,
	description = excluded.description,
	tags_json = excluded.tags_json,
	search_text = excluded.search_text,
	source_id = excluded.source_id,
	has_app = excluded.has_app,
	hidden = excluded.hidden,
	is_private = excluded.is_private,
	updated_at = CURRENT_TIMESTAMP;`.trim(),
		)
	}
	return statements.join('\n')
}

/**
 * Per-user feature-flag override (forced on) for a seeded account. Resolves
 * `users.id` by email so the FK matches the numeric override column.
 */
export function buildSeedFeatureFlagOverrideSql(input: {
	email: string
	flagKey: FeatureFlagKey
}) {
	const flagKey = quoteSqlString(input.flagKey)
	const email = quoteSqlString(input.email)
	return `
INSERT INTO feature_flag_user_overrides (flag_key, user_id, enabled, updated_by, updated_at)
SELECT ${flagKey}, u.id, 1, u.id, CURRENT_TIMESTAMP
FROM users u
WHERE u.email = ${email}
ON CONFLICT(flag_key, user_id) DO UPDATE SET
	enabled = excluded.enabled,
	updated_by = excluded.updated_by,
	updated_at = CURRENT_TIMESTAMP;`.trim()
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
	user_id, slug, provider, label, client_id,
	token_url, authorize_url, api_base_url, flow, extra_authorize_params_json
) VALUES (
	${userId}, 'google', 'google', 'Google', 'seed-google-client',
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
	scopes_json, required_hosts_json, connected_at
) VALUES
	(
		${userId}, 'google', 'google', NULL, 'Personal', '',
		'["openid","email"]', '["www.googleapis.com"]', CURRENT_TIMESTAMP
	),
	(
		${userId}, 'google-work', 'google', NULL, 'Work', '',
		'["openid","email"]', '["www.googleapis.com"]', CURRENT_TIMESTAMP
	)
ON CONFLICT(user_id, name) DO UPDATE SET
	account_label = excluded.account_label,
	app_slug = excluded.app_slug,
	updated_at = CURRENT_TIMESTAMP;`.trim()
}
