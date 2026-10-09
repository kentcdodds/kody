import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { insertSavedPackage } from '#worker/package-registry/repo.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import {
	AuthorizationError,
	runWithRequestPermissions,
} from '#worker/authorization/authorize.ts'
import { resolveSavedPackageImport } from '#worker/package-runtime/package-import-resolution.ts'
import { handleOpenApiRequest } from '#worker/open-api/http-handler.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import {
	cliCredentialBootstrapPolicy,
	mintCliCredentialBootstrap,
	redeemCliCredentialBootstrap,
} from './cli-credential-bootstrap.ts'
import { apiTokenLifetimeAliases, mintApiToken } from './service.ts'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)
const apiOrigin = 'https://api.kody.test'
const appOrigin = 'https://kody.test'
const email = 'bootstrap-local@example.com'
const username = 'bootstrap-local'

async function createApi() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, migrationsDirectory)
	const userId = testStableUserIdFromEmail(email)
	sqlite
		.prepare(
			`INSERT INTO users (id, username, email, password_hash, stable_user_id, email_verified_at)
			 VALUES (1, ?, ?, 'hash', ?, '2026-01-01T00:00:00.000Z')`,
		)
		.run(username, email, userId)
	const db = createD1FromSqlite(sqlite)
	await provisionPersonalOrg(db, {
		stableUserId: userId,
		username,
	})
	const env = {
		APP_DB: db,
		COOKIE_SECRET: 'test-cookie-secret',
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
		...createInMemoryUserMeterEnv().env,
	} as unknown as Env
	const pending: Array<Promise<unknown>> = []
	async function call(
		method: string,
		path: string,
		options: { token?: string; body?: unknown } = {},
	) {
		const headers = new Headers()
		if (options.token) headers.set('Authorization', `Bearer ${options.token}`)
		if (options.body !== undefined) {
			headers.set('Content-Type', 'application/json')
		}
		const response = await handleOpenApiRequest({
			request: new Request(`${apiOrigin}${path}`, {
				method,
				headers,
				...(options.body === undefined
					? {}
					: { body: JSON.stringify(options.body) }),
			}),
			env,
			appOrigin,
			waitUntil: (promise) => pending.push(promise),
		})
		await Promise.all(pending.splice(0))
		return {
			status: response.status,
			body: (await response.json()) as {
				error?: { code: string; message: string }
				scopes?: Array<string>
				modules?: Array<unknown>
				imports?: Array<string>
			},
		}
	}
	return { db, env, userId, call }
}

async function seedOwnedPackage(db: D1Database, userId: string) {
	const id = crypto.randomUUID()
	const name = `@${username}/demo`
	await insertSavedPackage(db, {
		id,
		user_id: userId,
		name,
		kody_id: 'demo',
		description: 'Bootstrap local-execute demo package',
		tags_json: '[]',
		search_text: null,
		source_id: `source-${id}`,
		has_app: 0,
		has_skills: 0,
		hidden: 0,
		is_private: 0,
	})
	return { id, name, specifier: `kody:${name}` as const }
}

test('default CLI bootstrap scopes resolve an owned package for local execute', async () => {
	const { db, env, userId, call } = await createApi()
	const packageInfo = await seedOwnedPackage(db, userId)

	const minted = await mintCliCredentialBootstrap({
		db,
		userId,
		lifetime: 'short',
	})
	expect(minted.scopes).toEqual([...cliCredentialBootstrapPolicy.defaultScopes])
	expect(minted.scopes).toContain('package:execute')

	const redeemed = await redeemCliCredentialBootstrap({
		db,
		code: minted.bootstrap_code,
		lifetime: 'short',
	})
	expect(redeemed.token.scopes).toEqual(
		[...cliCredentialBootstrapPolicy.defaultScopes].sort(),
	)

	const request = deriveRequestContext({
		user: {
			userId: personIdFromStored(userId),
			username,
		},
		source: { kind: 'api-token', tokenId: redeemed.token.id },
		scopes: redeemed.token.scopes,
	})
	const resolved = await runWithRequestPermissions({ env, request }, () =>
		resolveSavedPackageImport({
			db,
			userId,
			specifier: packageInfo.specifier,
		}),
	)
	expect(resolved?.row.id).toBe(packageInfo.id)

	// package-graph is the local-execute prep that previously lied with
	// "package not found" when package:execute was missing. Default bootstrap
	// must get past the permission gate (artifact publish is orthogonal).
	const graph = await call('POST', '/v1/local-execute/package-graph', {
		token: redeemed.token.token,
		body: {
			code: `import demo from '${packageInfo.specifier}'
export default async function main() { return demo }`,
		},
	})
	expect(graph.status).not.toBe(403)
	expect(graph.body.error?.code).not.toBe('insufficient_scope')
	expect(graph.body.error?.message ?? '').not.toMatch(
		/was not found for this user/i,
	)
})

test('package-graph names missing package:execute when the package exists', async () => {
	const { db, userId, call } = await createApi()
	const packageInfo = await seedOwnedPackage(db, userId)
	const narrow = await mintApiToken({
		db,
		userId,
		name: 'narrow-no-package-execute',
		scopes: ['org:execute', 'org:read'],
		idleTtlSeconds: apiTokenLifetimeAliases.short.idleTtlSeconds,
		maxLifetimeSeconds: apiTokenLifetimeAliases.short.maxLifetimeSeconds,
		createdVia: 'api',
	})

	const graph = await call('POST', '/v1/local-execute/package-graph', {
		token: narrow.token,
		body: {
			code: `import demo from '${packageInfo.specifier}'
export default async function main() { return demo }`,
		},
	})
	expect(graph.status).toBe(403)
	expect(graph.body.error?.code).toBe('insufficient_scope')
	expect(graph.body.error?.message).toMatch(/package:execute/)
	expect(graph.body.error?.message).toMatch(/@bootstrap-local\/demo/)
	expect(graph.body.error?.message).not.toMatch(/was not found for this user/i)
})

test('resolveSavedPackageImport throws AuthorizationError instead of null when scoped out', async () => {
	const { db, env, userId } = await createApi()
	const packageInfo = await seedOwnedPackage(db, userId)
	const request = deriveRequestContext({
		user: {
			userId: personIdFromStored(userId),
			username,
		},
		source: { kind: 'api-token', tokenId: 'narrow' },
		scopes: ['org:execute', 'org:read'],
	})
	const error = await runWithRequestPermissions({ env, request }, () =>
		resolveSavedPackageImport({
			db,
			userId,
			specifier: packageInfo.specifier,
		}),
	).catch((caught: unknown) => caught)
	expect(error).toBeInstanceOf(AuthorizationError)
	expect(error).toMatchObject({
		code: 'credential_scope',
		permission: 'package:execute',
	})
	expect(String(error)).toMatch(/package:execute/)
	expect(String(error)).not.toMatch(/was not found for this user/i)
})
