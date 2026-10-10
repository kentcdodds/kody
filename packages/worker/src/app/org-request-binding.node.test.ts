import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { ensureOrgsTestSchema } from '#worker/orgs/orgs-test-schema.ts'
import { loadRequestOrgResolution } from './org-request-binding.ts'

const adaId = 'a'.repeat(64)
const acmeId = 'b'.repeat(64)

async function createEnv() {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	await ensureOrgsTestSchema(db)
	const now = '2026-01-01T00:00:00.000Z'
	sqlite
		.prepare(
			`INSERT INTO orgs (id, slug, created_at, updated_at) VALUES (?, 'ada', ?, ?)`,
		)
		.run(adaId, now, now)
	sqlite
		.prepare(
			`INSERT INTO orgs (id, slug, created_at, updated_at) VALUES (?, 'acme', ?, ?)`,
		)
		.run(acmeId, now, now)
	sqlite
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'owner', ?)`,
		)
		.run(acmeId, adaId, now)
	return { APP_DB: db } as unknown as Env
}

test('account JSON from an org page binds that org', async () => {
	const env = await createEnv()
	const request = new Request('https://kody.test/account/secrets.json', {
		headers: { referer: 'https://kody.test/@acme/-/secrets' },
	})
	const resolution = await loadRequestOrgResolution(request, env, adaId)
	expect(resolution).toMatchObject({ org: { id: acmeId, slug: 'acme' } })
})

test('account JSON without an org page stays on the signup org', async () => {
	const env = await createEnv()
	const request = new Request('https://kody.test/account/secrets.json')
	await expect(loadRequestOrgResolution(request, env, adaId)).resolves.toBe(
		'personal',
	)
})

test('account JSON from another site does not bind an org', async () => {
	const env = await createEnv()
	const request = new Request('https://kody.test/account/secrets.json', {
		headers: { referer: 'https://evil.test/@acme/-/secrets' },
	})
	await expect(loadRequestOrgResolution(request, env, adaId)).resolves.toBe(
		'personal',
	)
})

test('account JSON referer for an org the person cannot access is denied', async () => {
	const env = await createEnv()
	const request = new Request('https://kody.test/account/jobs.json', {
		headers: { referer: 'https://kody.test/@ada/-/jobs' },
	})
	await expect(loadRequestOrgResolution(request, env, adaId)).resolves.toBe(
		'denied',
	)
})
