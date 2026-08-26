import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { handleIntegrationCredentialBackfillRequest } from './integration-credential-backfill-maintenance.ts'

const storeKey = 'backfill-handler-secret-store-key-32!!'

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
	return new Request(
		'https://example.com/__maintenance/backfill-integration-credentials',
		{
			method: input.method ?? 'POST',
			headers,
			body: input.body === undefined ? undefined : JSON.stringify(input.body),
		},
	)
}

test('integration credential backfill route enforces auth and returns leftover counts without ciphertext', async () => {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../migrations/', import.meta.url))
	const env = {
		APP_DB: createD1FromSqlite(sqlite),
		SECRET_STORE_KEY: storeKey,
		CAPABILITY_REINDEX_SECRET: 'secret',
	} as Env

	const methodResponse = await handleIntegrationCredentialBackfillRequest(
		createRequest({ method: 'GET', authorization: 'Bearer secret' }),
		env,
	)
	expect(methodResponse.status).toBe(405)

	const unauthorized = await handleIntegrationCredentialBackfillRequest(
		createRequest(),
		env,
	)
	expect(unauthorized.status).toBe(401)

	const unconfigured = await handleIntegrationCredentialBackfillRequest(
		createRequest({ authorization: 'Bearer secret' }),
		{ ...env, CAPABILITY_REINDEX_SECRET: ' ' },
	)
	expect(unconfigured.status).toBe(503)
	expect(await unconfigured.text()).toBe(
		'Integration credential backfill is not configured',
	)

	const badBody = await handleIntegrationCredentialBackfillRequest(
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

	const dryRun = await handleIntegrationCredentialBackfillRequest(
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
		userIntegrations: {
			access: {
				leftover: 0,
				scanned: 0,
				copied: 0,
				missingSecret: 0,
				skippedConcurrent: 0,
				remaining: 0,
			},
			refresh: {
				leftover: 0,
				scanned: 0,
				copied: 0,
				missingSecret: 0,
				skippedConcurrent: 0,
				remaining: 0,
			},
		},
		userOauthApps: {
			clientSecret: {
				leftover: 0,
				scanned: 0,
				copied: 0,
				missingSecret: 0,
				skippedConcurrent: 0,
				remaining: 0,
			},
		},
		missingSecrets: [],
	})
	expect(JSON.stringify(payload)).not.toMatch(/encrypted/i)
})
