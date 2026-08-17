import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { handleSecretReencryptRequest } from './secret-reencrypt-maintenance.ts'

const storeKey = 'reencrypt-handler-secret-store-key-32!!'

function createRequest(
	input: {
		method?: string
		authorization?: string
		body?: unknown
	} = {},
) {
	const headers = new Headers()
	if (input.authorization !== undefined) {
		headers.set('Authorization', input.authorization)
	}
	if (input.body !== undefined) {
		headers.set('Content-Type', 'application/json')
	}
	return new Request('https://example.com/__maintenance/reencrypt-secrets', {
		method: input.method ?? 'POST',
		headers,
		body: input.body === undefined ? undefined : JSON.stringify(input.body),
	})
}

test('secret re-encrypt maintenance route enforces auth and returns counts without ciphertext', async () => {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../migrations/', import.meta.url))
	const env = {
		APP_DB: createD1FromSqlite(sqlite),
		SECRET_STORE_KEY: storeKey,
		CAPABILITY_REINDEX_SECRET: 'secret',
	} as Env

	const methodResponse = await handleSecretReencryptRequest(
		createRequest({ method: 'GET', authorization: 'Bearer secret' }),
		env,
	)
	expect(methodResponse.status).toBe(405)

	const unauthorized = await handleSecretReencryptRequest(createRequest(), env)
	expect(unauthorized.status).toBe(401)

	const unconfigured = await handleSecretReencryptRequest(
		createRequest({ authorization: 'Bearer secret' }),
		{ ...env, CAPABILITY_REINDEX_SECRET: ' ' },
	)
	expect(unconfigured.status).toBe(503)
	expect(await unconfigured.text()).toBe(
		'Secret re-encryption is not configured',
	)

	const badBody = await handleSecretReencryptRequest(
		createRequest({
			authorization: 'Bearer secret',
			body: { confirm: true },
		}),
		env,
	)
	expect(badBody.status).toBe(500)
	await expect(badBody.json()).resolves.toEqual({
		ok: false,
		error: 'unknown request field: confirm',
	})

	const dryRun = await handleSecretReencryptRequest(
		createRequest({
			authorization: 'Bearer secret',
			body: { dryRun: true, maxRows: 10 },
		}),
		env,
	)
	expect(dryRun.status).toBe(200)
	const payload = (await dryRun.json()) as Record<string, unknown>
	expect(payload).toEqual({
		ok: true,
		dryRun: true,
		secretEntries: {
			scanned: 0,
			rewritten: 0,
			skippedConcurrent: 0,
			decryptFailed: 0,
			remaining: 0,
		},
		remoteConnectorSettings: {
			scanned: 0,
			rewritten: 0,
			skippedConcurrent: 0,
			decryptFailed: 0,
			remaining: 0,
		},
		platformOauthApps: {
			scanned: 0,
			rewritten: 0,
			skippedConcurrent: 0,
			decryptFailed: 0,
			remaining: 0,
		},
		decryptFailures: [],
	})
	expect(JSON.stringify(payload)).not.toMatch(/encrypted/i)
})
