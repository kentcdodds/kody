import { quoteSqlString } from '@kody-internal/shared/sql-literals.ts'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { createPasswordHash } from '@kody-internal/shared/password-hash.ts'
import { hashVerificationToken } from '../packages/worker/src/app/email-verification.ts'
import { createStableUserIdFromEmail } from '../packages/worker/src/user-id.ts'
import { buildRoleAssignmentSql, buildSeedUserSql } from '../tools/seed-sql.ts'
import { seedCommunitySnapshotInE2eKv } from './kv-utils.ts'

const projectRoot = path.resolve(import.meta.dirname, '..')

const e2eCommunityPinnedCommit = 'abc1234567890abcdef1234567890abcdef12345678'

function sleepSync(ms: number) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

// Parallel Playwright workers and the test web server share one local D1
// SQLite file, so concurrent `d1 execute` calls can hit transient
// SQLITE_BUSY lock contention. Retry those with backoff.
export function executeE2eD1Command(sql: string) {
	const maxAttempts = 6
	let lastFailure = ''
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const result = spawnSync(
			process.execPath,
			[
				'--env-file=packages/worker/.env',
				'./wrangler-env.ts',
				'd1',
				'execute',
				'APP_DB',
				'--local',
				'--persist-to',
				'.wrangler/state/e2e',
				'--command',
				sql,
			],
			{
				cwd: projectRoot,
				encoding: 'utf8',
				stdio: 'pipe',
				env: {
					...process.env,
					CLOUDFLARE_ENV: 'test',
				},
			},
		)

		if (result.status === 0) return

		lastFailure = `${result.stdout}\n${result.stderr}`
		const isLockContention =
			lastFailure.includes('SQLITE_BUSY') ||
			lastFailure.includes('database is locked')
		if (!isLockContention || attempt === maxAttempts) break
		sleepSync(150 * 2 ** (attempt - 1))
	}

	throw new Error(`Failed to execute E2E D1 command:\n${lastFailure}`)
}

export async function seedUserInE2eDatabase(input: {
	email: string
	username: string
	password: string
	admin?: boolean
}) {
	const passwordHash = await createPasswordHash(input.password)
	executeE2eD1Command(
		buildSeedUserSql({
			email: input.email,
			username: input.username,
			passwordHash,
			admin: input.admin,
		}),
	)
}

export async function seedSavedPackageInE2eDatabase(input: {
	ownerEmail: string
	packageId: string
	kodyId: string
	name: string
}) {
	const ownerUserId = await createStableUserIdFromEmail(input.ownerEmail)
	const sourceId = `source-${input.packageId}`
	executeE2eD1Command(
		`INSERT INTO saved_packages (
			id, user_id, name, kody_id, description, tags_json, source_id, has_app
		) VALUES (
			${quoteSqlString(input.packageId)},
			${quoteSqlString(ownerUserId)},
			${quoteSqlString(input.name)},
			${quoteSqlString(input.kodyId)},
			'Package seeded for account picker e2e coverage.',
			'[]',
			${quoteSqlString(sourceId)},
			0
		)
		ON CONFLICT(id) DO UPDATE SET
			name = excluded.name,
			kody_id = excluded.kody_id,
			updated_at = CURRENT_TIMESTAMP;`,
	)
}

export async function seedIntegrationInE2eDatabase(input: {
	ownerEmail: string
	name: string
	tokenUrl: string
	apiBaseUrl: string
	requiredHosts: Array<string>
	scopes: Array<string>
}) {
	const ownerUserId = await createStableUserIdFromEmail(input.ownerEmail)
	const bucketId = `e2e-integration-bucket-${ownerUserId}`
	const valueName = `_integration:${input.name}`
	const value = JSON.stringify({
		name: input.name,
		tokenUrl: input.tokenUrl,
		apiBaseUrl: input.apiBaseUrl,
		flow: 'pkce',
		clientIdValueName: `${input.name}-client-id`,
		clientSecretSecretName: null,
		accessTokenSecretName: `${input.name}-access-token`,
		refreshTokenSecretName: `${input.name}-refresh-token`,
		requiredHosts: input.requiredHosts,
		authorization: {
			authorizeUrl: `https://auth.${input.name}.example.com/authorize`,
			scopes: input.scopes,
		},
	})
	executeE2eD1Command(
		`INSERT INTO value_buckets (id, user_id, scope, binding_key)
		VALUES (
			${quoteSqlString(bucketId)},
			${quoteSqlString(ownerUserId)},
			'user',
			''
		)
		ON CONFLICT(user_id, scope, binding_key) DO UPDATE SET
			updated_at = CURRENT_TIMESTAMP;
		INSERT INTO value_entries (bucket_id, name, description, value)
		VALUES (
			${quoteSqlString(bucketId)},
			${quoteSqlString(valueName)},
			${quoteSqlString(`OAuth integration config for ${input.name}`)},
			${quoteSqlString(value)}
		)
		ON CONFLICT(bucket_id, name) DO UPDATE SET
			value = excluded.value,
			updated_at = CURRENT_TIMESTAMP;`,
	)
}

export function assignRoleInE2eDatabase(email: string, role: string) {
	executeE2eD1Command(buildRoleAssignmentSql({ email, role }))
}

export function clearAuthRateLimitsInE2eDatabase() {
	executeE2eD1Command(
		`CREATE TABLE IF NOT EXISTS _rate_limits (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			key TEXT NOT NULL,
			ts INTEGER NOT NULL
		);
		DELETE FROM _rate_limits WHERE key LIKE 'auth:ip:%';`,
	)
}

export async function setEmailVerificationTokenInE2eDatabase(input: {
	email: string
	token: string
	expiresAt?: number
}) {
	const tokenHash = await hashVerificationToken(input.token)
	const expiresAt = input.expiresAt ?? Date.now() + 60 * 60 * 1000
	const sql = `
DELETE FROM email_verifications
WHERE user_id IN (SELECT id FROM users WHERE email = ${quoteSqlString(input.email)});
INSERT INTO email_verifications (user_id, token_hash, expires_at)
SELECT id, ${quoteSqlString(tokenHash)}, ${expiresAt}
FROM users
WHERE email = ${quoteSqlString(input.email)};`.trim()
	executeE2eD1Command(sql)
}

export async function seedCommunityListingInE2eDatabase(input: {
	listingId: string
	ownerEmail: string
	name: string
	description: string
	tags?: Array<string>
	kodyId?: string
	packageId?: string
	readmeContent?: string | null
	sourceId?: string
	trusted?: boolean
	/** Implies nothing about trust: pass `trusted: true` too for an
	 * effectively featured (onboarding-visible) listing. */
	featured?: boolean
}) {
	const ownerUserId = await createStableUserIdFromEmail(input.ownerEmail)
	const tagsJson = JSON.stringify(input.tags ?? [])
	const kodyId = input.kodyId ?? input.listingId
	const packageId = input.packageId ?? `pkg-${input.listingId}`
	const readmeContent = input.readmeContent ?? null
	const sourceId = input.sourceId ?? `src-${input.listingId}`
	const trustedCommit = input.trusted
		? quoteSqlString(e2eCommunityPinnedCommit)
		: 'NULL'
	const trustedByUserId = input.trusted
		? quoteSqlString('e2e-seeded-admin')
		: 'NULL'
	const trustedAt = input.trusted ? 'CURRENT_TIMESTAMP' : 'NULL'
	const featuredAt = input.featured ? 'CURRENT_TIMESTAMP' : 'NULL'
	const sql = `
INSERT INTO community_listings (
	id,
	owner_user_id,
	package_id,
	source_id,
	kody_id,
	name,
	description,
	tags_json,
	readme_content,
	license,
	pinned_commit,
	status,
	trusted_commit,
	trusted_by_user_id,
	trusted_at,
	featured_at
) VALUES (
	${quoteSqlString(input.listingId)},
	${quoteSqlString(ownerUserId)},
	${quoteSqlString(packageId)},
	${quoteSqlString(sourceId)},
	${quoteSqlString(kodyId)},
	${quoteSqlString(input.name)},
	${quoteSqlString(input.description)},
	${quoteSqlString(tagsJson)},
	${readmeContent === null ? 'NULL' : quoteSqlString(readmeContent)},
	'MIT',
	${quoteSqlString(e2eCommunityPinnedCommit)},
	'active',
	${trustedCommit},
	${trustedByUserId},
	${trustedAt},
	${featuredAt}
)
ON CONFLICT(id) DO UPDATE SET
	owner_user_id = excluded.owner_user_id,
	name = excluded.name,
	description = excluded.description,
	tags_json = excluded.tags_json,
	readme_content = excluded.readme_content,
	status = excluded.status,
	trusted_commit = excluded.trusted_commit,
	trusted_by_user_id = excluded.trusted_by_user_id,
	trusted_at = excluded.trusted_at,
	featured_at = excluded.featured_at,
	published_at = CURRENT_TIMESTAMP,
	updated_at = CURRENT_TIMESTAMP;`.trim()
	executeE2eD1Command(sql)
	// Icon requests resolve through the listing's KV snapshot; without one the
	// worker logs `community-icon-load-failed` on every page view. The
	// snapshot also carries a minimal installable package source so install
	// and fork flows exercise the real snapshot-read path.
	seedCommunitySnapshotInE2eKv({
		listingId: input.listingId,
		pinnedCommit: e2eCommunityPinnedCommit,
		files: buildE2eCommunityPackageFiles({ name: input.name, kodyId }),
	})
}

function buildE2eCommunityPackageFiles(input: {
	name: string
	kodyId: string
}) {
	return {
		'package.json': `${JSON.stringify(
			{
				name: input.name,
				license: 'MIT',
				exports: { '.': './src/index.ts' },
				kody: {
					id: input.kodyId,
					description: 'Package seeded for community e2e tests',
				},
			},
			null,
			'\t',
		)}\n`,
		'README.md':
			'# E2E Community Package\n\n## Intent\n\nExercise community flows in e2e tests.\n',
		'src/index.ts':
			'export default async function main() {\n\treturn { ok: true }\n}\n',
	}
}

export function updateCommunityListingDescriptionInE2eDatabase(input: {
	listingId: string
	description: string
}) {
	const sql = `
UPDATE community_listings
SET description = ${quoteSqlString(input.description)},
    updated_at = CURRENT_TIMESTAMP
WHERE id = ${quoteSqlString(input.listingId)};`.trim()
	executeE2eD1Command(sql)
}

export async function seedCommunityForkInE2eDatabase(input: {
	listingId: string
	forkerEmail: string
	forkId?: string
}) {
	const forkerUserId = await createStableUserIdFromEmail(input.forkerEmail)
	const forkId = input.forkId ?? `fork-${input.listingId}`
	const sql = `
INSERT INTO community_forks (
	id,
	listing_id,
	forker_user_id,
	origin_commit,
	forked_package_id,
	forked_source_id,
	target_kody_id
) VALUES (
	${quoteSqlString(forkId)},
	${quoteSqlString(input.listingId)},
	${quoteSqlString(forkerUserId)},
	${quoteSqlString(e2eCommunityPinnedCommit)},
	${quoteSqlString(`pkg-fork-${forkId}`)},
	${quoteSqlString(`src-fork-${forkId}`)},
	${quoteSqlString(input.listingId)}
);`.trim()
	executeE2eD1Command(sql)
}
