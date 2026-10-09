import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { insertSavedPackage } from '#worker/package-registry/repo.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import {
	AuthorizationError,
	runWithRequestPermissions,
} from '#worker/authorization/authorize.ts'
import { resolveSavedPackageImport } from '#worker/package-runtime/package-import-resolution.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import {
	cliCredentialBootstrapPolicy,
	mintCliCredentialBootstrap,
	redeemCliCredentialBootstrap,
} from './cli-credential-bootstrap.ts'
import { apiTokenLifetimeAliases, mintApiToken } from './service.ts'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)
const email = 'bootstrap-local@example.com'
const username = 'bootstrap-local'

async function createHarness() {
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
	const env = { APP_DB: db } as Env
	return { db, env, userId }
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
	const { db, env, userId } = await createHarness()
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

	// package-graph binds request permissions the same way; resolving the
	// owned package under the redeemed token's scopes is the gate that used
	// to fail closed as "package not found".
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
})

test('missing package:execute names the scope instead of package-not-found', async () => {
	const { db, env, userId } = await createHarness()
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
	const request = deriveRequestContext({
		user: {
			userId: personIdFromStored(userId),
			username,
		},
		source: { kind: 'api-token', tokenId: narrow.id },
		scopes: narrow.scopes,
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
	expect(String(error)).toMatch(/@bootstrap-local\/demo/)
	expect(String(error)).not.toMatch(/was not found for this user/i)
})
