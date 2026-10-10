import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { ensureOrgsTestSchema } from '#worker/orgs/orgs-test-schema.ts'
import {
	isOrgRequestDenied,
	loadRequestOrgResolution,
} from './org-request-binding.ts'

const adaId = 'a'.repeat(64)
const acmeId = 'b'.repeat(64)

async function createEnv() {
	return (await createEnvWithSqlite()).env
}

async function createEnvWithSqlite() {
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
	return { env: { APP_DB: db } as unknown as Env, sqlite }
}

test('account package JSON stays on the signup org from a team page', async () => {
	const env = await createEnv()
	const request = new Request('https://kody.test/account/packages.json', {
		headers: { referer: 'https://kody.test/@acme/-/packages' },
	})
	await expect(loadRequestOrgResolution(request, env, adaId)).resolves.toBe(
		'personal',
	)
})

test('account JSON from an org page binds that org', async () => {
	const env = await createEnv()
	const request = new Request('https://kody.test/account/secrets.json', {
		headers: { referer: 'https://kody.test/@acme/-/secrets' },
	})
	const resolution = await loadRequestOrgResolution(request, env, adaId)
	expect(resolution).toMatchObject({ org: { id: acmeId, slug: 'acme' } })
})

test('connected agents JSON from a team Connections page binds that org', async () => {
	const env = await createEnv()
	const request = new Request(
		'https://kody.test/account/connected-agents.json',
		{
			headers: { referer: 'https://kody.test/@acme/-/connections' },
		},
	)
	const resolution = await loadRequestOrgResolution(request, env, adaId)
	expect(resolution).toMatchObject({ org: { id: acmeId, slug: 'acme' } })
})

test('sign-in providers JSON stays on the signup org from a team page', async () => {
	const env = await createEnv()
	const request = new Request('https://kody.test/account/connections.json', {
		headers: { referer: 'https://kody.test/@acme/-/connections' },
	})
	await expect(loadRequestOrgResolution(request, env, adaId)).resolves.toBe(
		'personal',
	)
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

test('a request naming an org the person cannot use is denied, never the signup org', async () => {
	const env = await createEnv()
	const denied = (url: string, referer?: string) =>
		isOrgRequestDenied(
			new Request(url, referer ? { headers: { referer } } : {}),
			env,
			adaId,
		)
	// Ada belongs to acme, not to the `ada` org row seeded here.
	await expect(denied('https://kody.test/@ada/-/memories')).resolves.toBe(true)
	await expect(denied('https://kody.test/@ada/-/settings.json')).resolves.toBe(
		true,
	)
	await expect(
		denied(
			'https://kody.test/account/workflows.json',
			'https://kody.test/@ada/-/workflows',
		),
	).resolves.toBe(true)
	await expect(
		denied(
			'https://kody.test/account/memories-export.json',
			'https://kody.test/@ada/-/memories',
		),
	).resolves.toBe(true)
	await expect(denied('https://kody.test/@acme/-/memories')).resolves.toBe(
		false,
	)
	await expect(
		denied(
			'https://kody.test/account/webhooks.json',
			'https://kody.test/@acme/-/webhooks',
		),
	).resolves.toBe(false)
	// No org on the URL or Referer: the signup org, never denied.
	await expect(denied('https://kody.test/account/memories.json')).resolves.toBe(
		false,
	)
	await expect(
		denied(
			'https://kody.test/account/profile.json',
			'https://kody.test/@ada/-/memories',
		),
	).resolves.toBe(false)
	// Public pages under the handle are not org-bound.
	await expect(denied('https://kody.test/@ada')).resolves.toBe(false)
})

test('org sections follow the page gate for grant-only collaborators', async () => {
	const { env, sqlite } = await createEnvWithSqlite()
	const now = '2026-01-01T00:00:00.000Z'
	sqlite
		.prepare(`DELETE FROM org_memberships WHERE org_id = ? AND user_id = ?`)
		.run(acmeId, adaId)
	sqlite
		.prepare(
			`INSERT INTO grants (id, org_id, resource_type, resource_id, subject_type,
			   subject_id, preset, created_by_user_id, created_at, updated_at)
			 VALUES ('grant-1', ?, 'secret', 'secret-1', 'user', ?, 'use', ?, ?, ?)`,
		)
		.run(acmeId, adaId, acmeId, now, now)
	const denied = (url: string, referer: string) =>
		isOrgRequestDenied(new Request(url, { headers: { referer } }), env, adaId)
	await expect(
		denied(
			'https://kody.test/account/connected-agents.json',
			'https://kody.test/@acme/-/connections',
		),
	).resolves.toBe(false)
	await expect(
		denied(
			'https://kody.test/account/memories.json',
			'https://kody.test/@acme/-/connections',
		),
	).resolves.toBe(true)
	const deniedPage = (url: string) =>
		isOrgRequestDenied(new Request(url), env, adaId)
	await expect(
		deniedPage('https://kody.test/@acme/-/connections'),
	).resolves.toBe(false)
	await expect(deniedPage('https://kody.test/@acme/-/memories')).resolves.toBe(
		true,
	)
	await expect(
		deniedPage('https://kody.test/@acme/-/packages.json'),
	).resolves.toBe(true)
	// Management pages check their own permission once the org is bound.
	await expect(deniedPage('https://kody.test/@acme/-/settings')).resolves.toBe(
		false,
	)
})
