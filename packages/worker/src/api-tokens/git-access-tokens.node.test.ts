import { parseGitAccessToken } from '@kody-internal/shared/api-token-format.ts'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import {
	authenticateGitAccessToken,
	gitAccessTokenMatchesRepo,
	mintGitAccessToken,
} from './git-access-tokens.ts'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)
const start = new Date('2026-10-12T12:00:00.000Z')

function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, migrationsDirectory)
	return { db: createD1FromSqlite(sqlite) }
}

test('git access token mints once, authenticates, expires, and is repo-scoped', async () => {
	const { db } = createDb()
	const userId = ownerIdFromStored(testStableUserIdFromEmail('git@example.com'))
	const minted = await mintGitAccessToken({
		db,
		userId,
		host: 'kody.codes',
		path: '/@ada/cloudflare.git',
		ownerHandle: 'ada',
		repoName: 'cloudflare',
		resourceKind: 'package',
		resourceId: 'pkg-1',
		resourceOrgId: userId,
		ttlSeconds: 3600,
		now: start,
	})
	expect(minted.username).toBe('x')
	expect(parseGitAccessToken(minted.password)?.tokenId).toBeTruthy()
	expect(minted.expires_at).toBe(
		new Date(start.getTime() + 3600_000).toISOString(),
	)

	const auth = await authenticateGitAccessToken({
		db,
		token: minted.password,
		now: new Date(start.getTime() + 60_000),
	})
	expect(auth.ok).toBe(true)
	if (!auth.ok) throw new Error('expected ok')
	expect(
		gitAccessTokenMatchesRepo({
			record: auth.record,
			ownerHandle: 'ada',
			repoName: 'cloudflare',
		}),
	).toBe(true)
	expect(
		gitAccessTokenMatchesRepo({
			record: auth.record,
			ownerHandle: 'ada',
			repoName: 'other',
		}),
	).toBe(false)

	const expired = await authenticateGitAccessToken({
		db,
		token: minted.password,
		now: new Date(start.getTime() + 3600_001),
	})
	expect(expired).toEqual({ ok: false, reason: 'expired' })

	const other = await mintGitAccessToken({
		db,
		userId,
		host: 'kody.codes',
		path: '/@ada/other.git',
		ownerHandle: 'ada',
		repoName: 'other',
		resourceKind: 'repo',
		resourceId: 'repo-1',
		resourceOrgId: userId,
		now: start,
	})
	const otherAuth = await authenticateGitAccessToken({
		db,
		token: other.password,
		now: start,
	})
	expect(otherAuth.ok).toBe(true)
	if (!otherAuth.ok) throw new Error('expected ok')
	expect(
		gitAccessTokenMatchesRepo({
			record: otherAuth.record,
			ownerHandle: 'ada',
			repoName: 'cloudflare',
		}),
	).toBe(false)
})
