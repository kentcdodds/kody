import { quoteSqlString } from '@kody-internal/shared/sql-literals.ts'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { createPasswordHash } from '@kody-internal/shared/password-hash.ts'
import { hashVerificationToken } from '../packages/worker/src/app/email-verification.ts'
import { createStableUserIdFromEmail } from '../packages/worker/src/user-id.ts'
import { buildRoleAssignmentSql, buildSeedUserSql } from '../tools/seed-sql.ts'

const projectRoot = path.resolve(import.meta.dirname, '..')

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
}) {
	const passwordHash = await createPasswordHash(input.password)
	executeE2eD1Command(
		buildSeedUserSql({
			email: input.email,
			username: input.username,
			passwordHash,
		}),
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
}) {
	const ownerUserId = await createStableUserIdFromEmail(input.ownerEmail)
	const tagsJson = JSON.stringify(input.tags ?? [])
	const kodyId = input.kodyId ?? input.listingId
	const packageId = input.packageId ?? `pkg-${input.listingId}`
	const readmeContent = input.readmeContent ?? null
	const sourceId = input.sourceId ?? `src-${input.listingId}`
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
	status
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
	'abc1234567890abcdef1234567890abcdef12345678',
	'active'
)
ON CONFLICT(id) DO UPDATE SET
	owner_user_id = excluded.owner_user_id,
	name = excluded.name,
	description = excluded.description,
	tags_json = excluded.tags_json,
	readme_content = excluded.readme_content,
	status = excluded.status,
	updated_at = CURRENT_TIMESTAMP;`.trim()
	executeE2eD1Command(sql)
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
	'abc1234567890abcdef1234567890abcdef12345678',
	${quoteSqlString(`pkg-fork-${forkId}`)},
	${quoteSqlString(`src-fork-${forkId}`)},
	${quoteSqlString(input.listingId)}
);`.trim()
	executeE2eD1Command(sql)
}
