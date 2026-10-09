import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { secretAuthorityArgName } from '#mcp/secrets/secret-authority.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { type ApiInvocationContext } from './context.ts'
import { runCapabilityProxyAuthenticatedFetch } from './capability-proxy-authenticated-fetch.ts'
import { runCapabilityProxyOauthClientCredentials } from './capability-proxy-oauth-client-credentials.ts'
import { createCapabilityProxyPackageHostTools } from './capability-proxy-package-grants.ts'

vi.mock('#worker/storage-runner.ts', () => ({
	createPackageStorageAccessDeniedMessage: (packageId: string) =>
		`Package ${packageId} is not authorized for storage access.`,
	createPackageStorageKodyTools: () => ({
		packageStorageGet: async () => ({ value: 'owned-storage-value' }),
	}),
}))

vi.mock('#mcp/secrets/package-access.ts', () => ({
	resolvePackageMountedSecret: async () => ({ ref: 'owned-secret-ref' }),
}))

vi.mock('#mcp/run-kody-registry.ts', () => ({
	buildKodyFns: async () => ({}),
}))

vi.mock('#mcp/execute-modules/kody-runtime-utils.ts', () => ({
	createAuthenticatedFetch: async () => async () => new Response('ok'),
	oauthClientCredentials: async () => ({ access_token: 'ok' }),
}))

const migrationsDirectory = new URL('../../migrations/', import.meta.url)
const callerUserId = 'a'.repeat(64)
const packageOwnerId = 'b'.repeat(64)
const ownedPackageId = 'owned-package'
const otherOrgPackageId = 'other-org-package'

function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, migrationsDirectory)
	sqlite
		.prepare(
			`INSERT INTO users (username, email, password_hash, stable_user_id)
			 VALUES ('local-caller', 'caller@example.com', 'hash', ?),
			        ('package-owner', 'owner@example.com', 'hash', ?)`,
		)
		.run(callerUserId, packageOwnerId)
	const packageRows: Array<[string, string]> = [
		[ownedPackageId, callerUserId],
		[otherOrgPackageId, packageOwnerId],
	]
	for (const [id, userId] of packageRows) {
		sqlite
			.prepare(
				`INSERT INTO saved_packages
					(id, user_id, name, kody_id, description, source_id)
				 VALUES (?, ?, ?, ?, ?, ?)`,
			)
			.run(id, userId, id, id, 'Test package', `source-${id}`)
	}
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

function createContext(db: D1Database): ApiInvocationContext {
	const callerContext = createMcpCallerContext({
		source: { kind: 'mcp-oauth' },
		baseUrl: 'https://kody.codes',
		executionOrigin: 'interactive',
		user: {
			userId: personIdFromStored(callerUserId),
			email: 'caller@example.com',
			displayName: 'Caller',
		},
		storageContext: null,
		repoContext: null,
	})
	if (!callerContext.user) throw new Error('Caller context needs a user')
	return {
		env: { APP_DB: db } as Env,
		callerContext: { ...callerContext, user: callerContext.user },
		principal: { kind: 'mcp' },
		getFeatureFlags: async () => ({
			'demo-indicator': false,
			'jev-search-rerank': false,
			'execute-invoke': false,
			'connection-profiles': false,
			'mcp-skills-extension': false,
			'mcp-events-extension': false,
		}),
	}
}

async function packageStorageGet(db: D1Database, packageId: string) {
	const tools = await createCapabilityProxyPackageHostTools({
		env: { APP_DB: db } as Env,
		callerContext: createContext(db).callerContext,
	})
	return tools.packageStorageGet?.({ packageId, key: 'cursor' })
}

async function packageSecretGet(db: D1Database, packageId: string) {
	const tools = await createCapabilityProxyPackageHostTools({
		env: { APP_DB: db } as Env,
		callerContext: createContext(db).callerContext,
	})
	return tools.packageSecretGet?.({
		alias: 'client-token',
		[secretAuthorityArgName]: packageId,
	})
}

const packageOperations = [
	{
		name: 'packageStorageGet',
		run: packageStorageGet,
		expected: { value: 'owned-storage-value' },
	},
	{
		name: 'package secret get',
		run: packageSecretGet,
		expected: { value: 'owned-secret-ref' },
	},
	{
		name: 'authenticatedFetch',
		run: async (db: D1Database, packageId: string) =>
			runCapabilityProxyAuthenticatedFetch({
				ctx: createContext(db),
				args: [
					{
						providerName: 'test',
						packageId,
						request: { url: 'https://api.example.test/resource' },
					},
				],
			}),
		expected: {
			status: 200,
			statusText: '',
			headers: { 'content-type': 'text/plain;charset=UTF-8' },
			bodyBase64: 'b2s=',
		},
	},
	{
		name: 'oauthClientCredentials',
		run: async (db: D1Database, packageId: string) =>
			runCapabilityProxyOauthClientCredentials({
				ctx: createContext(db),
				args: [
					{
						tokenUrl: 'https://oauth.example.test/token',
						clientIdSecret: 'client-id',
						clientSecretSecret: 'client-secret',
						packageId,
					},
				],
			}),
		expected: { access_token: 'ok' },
	},
]

for (const operation of packageOperations) {
	test(`${operation.name} only accepts caller-owned package ids for local execute`, async () => {
		const { db } = createDb()

		await expect(operation.run(db, ownedPackageId)).resolves.toEqual(
			operation.expected,
		)
		await expect(operation.run(db, otherOrgPackageId)).rejects.toThrow(
			/not authorized for storage access/,
		)
		await expect(operation.run(db, 'unknown-package')).rejects.toThrow(
			/not authorized for storage access/,
		)
	})
}
