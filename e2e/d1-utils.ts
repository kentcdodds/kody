import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { createPasswordHash } from '@kody-internal/shared/password-hash.ts'
import { createStableUserIdFromEmail } from '../packages/worker/src/user-id.ts'

const projectRoot = path.resolve(import.meta.dirname, '..')

function quoteSql(value: string) {
	return `'${value.replace(/'/g, "''")}'`
}

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

function buildSeedUserSql(input: {
	email: string
	username: string
	passwordHash: string
}) {
	return `
INSERT INTO users (username, email, password_hash)
VALUES (${quoteSql(input.username)}, ${quoteSql(input.email)}, ${quoteSql(input.passwordHash)})
ON CONFLICT(email) DO UPDATE SET
  username = excluded.username,
  password_hash = excluded.password_hash,
  updated_at = CURRENT_TIMESTAMP;
INSERT OR IGNORE INTO user_roles (user_id, role_id)
SELECT u.id, r.id
FROM users u, roles r
WHERE u.email = ${quoteSql(input.email)} AND r.name = 'user';`.trim()
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
	const sql = `
INSERT OR IGNORE INTO user_roles (user_id, role_id)
SELECT u.id, r.id
FROM users u, roles r
WHERE u.email = ${quoteSql(email)} AND r.name = ${quoteSql(role)};`.trim()
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
	sourceId?: string
}) {
	const ownerUserId = await createStableUserIdFromEmail(input.ownerEmail)
	const tagsJson = JSON.stringify(input.tags ?? [])
	const kodyId = input.kodyId ?? input.listingId
	const packageId = input.packageId ?? `pkg-${input.listingId}`
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
	license,
	pinned_commit,
	status
) VALUES (
	${quoteSql(input.listingId)},
	${quoteSql(ownerUserId)},
	${quoteSql(packageId)},
	${quoteSql(sourceId)},
	${quoteSql(kodyId)},
	${quoteSql(input.name)},
	${quoteSql(input.description)},
	${quoteSql(tagsJson)},
	'MIT',
	'abc1234567890abcdef1234567890abcdef12345678',
	'active'
)
ON CONFLICT(id) DO UPDATE SET
	owner_user_id = excluded.owner_user_id,
	name = excluded.name,
	description = excluded.description,
	tags_json = excluded.tags_json,
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
SET description = ${quoteSql(input.description)},
    updated_at = CURRENT_TIMESTAMP
WHERE id = ${quoteSql(input.listingId)};`.trim()
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
	${quoteSql(forkId)},
	${quoteSql(input.listingId)},
	${quoteSql(forkerUserId)},
	'abc1234567890abcdef1234567890abcdef12345678',
	${quoteSql(`pkg-fork-${forkId}`)},
	${quoteSql(`src-fork-${forkId}`)},
	${quoteSql(input.listingId)}
);`.trim()
	executeE2eD1Command(sql)
}
