import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import {
	listSecrets,
	lockSecretToPackage,
	saveSecret,
} from '#mcp/secrets/service.ts'
import { applyAllMigrations as applyRepositoryMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { secretLockCapability } from './secret-lock.ts'

const migrationsDirectory = new URL('../../../../migrations/', import.meta.url)

function createHarness() {
	const sqlite = new DatabaseSync(':memory:')
	applyRepositoryMigrations(sqlite, migrationsDirectory)
	const env = {
		APP_DB: createD1FromSqlite(sqlite),
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
		...createInMemoryUserMeterEnv().env,
	} as Env
	return { sqlite, env }
}

function seedPackage(
	sqlite: DatabaseSync,
	input: { id: string; userId: string; kodyId: string },
) {
	sqlite
		.prepare(
			`INSERT INTO saved_packages (
				id, user_id, name, kody_id, description, source_id
			) VALUES (?, ?, ?, ?, ?, ?)`,
		)
		.run(
			input.id,
			input.userId,
			input.kodyId,
			input.kodyId,
			'',
			`source-${input.id}`,
		)
}

async function allowedPackagesFor(
	env: Env,
	userId: string,
	name: string,
): Promise<Array<string>> {
	const secrets = await listSecrets({ env, userId, scope: 'user' })
	return secrets.find((secret) => secret.name === name)?.allowedPackages ?? []
}

test('secretLock returns an approval URL without widening allowed_packages', async () => {
	const { sqlite, env } = createHarness()
	const userId = 'user-secret-lock'
	seedPackage(sqlite, { id: 'pkg-notes', userId, kodyId: 'notes' })
	seedPackage(sqlite, { id: 'pkg-mail', userId, kodyId: 'mail' })
	await saveSecret({
		env,
		userId,
		scope: 'user',
		name: 'openai-api-key',
		value: 'sk-test',
	})

	const ctx = {
		env,
		callerContext: createMcpCallerContext({
			baseUrl: 'https://kody.codes',
			user: {
				userId,
				email: 'alice@example.com',
				displayName: 'Alice',
			},
		}),
	}

	const approvalUrl =
		'https://kody.codes/account/secrets/user/openai-api-key?package_id=pkg-notes&package=notes'
	const pending = await secretLockCapability.handler(
		{ name: 'openai-api-key', package_id: 'pkg-notes' },
		ctx,
	)
	expect(pending).toEqual({
		name: 'openai-api-key',
		scope: 'user',
		allowed_packages: [],
		usage_url: 'https://kody.codes/account/secrets/user/openai-api-key',
		status: 'approval_required',
		approval_url: approvalUrl,
		message:
			"Agents cannot add packages to a user secret's allowed_packages. Only the account owner can grant access on the website. Send the user this approval link and wait: https://kody.codes/account/secrets/user/openai-api-key?package_id=pkg-notes&package=notes",
	})
	expect(await allowedPackagesFor(env, userId, 'openai-api-key')).toEqual([])

	const websiteGrant = await lockSecretToPackage({
		env,
		userId,
		name: 'openai-api-key',
		packageId: 'pkg-notes',
	})
	expect(websiteGrant.allowedPackages).toEqual(['pkg-notes'])

	const alreadyGranted = await secretLockCapability.handler(
		{ name: 'openai-api-key', package_id: 'pkg-notes' },
		ctx,
	)
	expect(alreadyGranted).toEqual({
		name: 'openai-api-key',
		scope: 'user',
		allowed_packages: ['pkg-notes'],
		usage_url: 'https://kody.codes/account/secrets/user/openai-api-key',
		status: 'already_granted',
		approval_url: approvalUrl,
		message:
			'Package "notes" already has an allowed_packages grant on this secret.',
	})
	expect(await allowedPackagesFor(env, userId, 'openai-api-key')).toEqual([
		'pkg-notes',
	])

	const additional = await secretLockCapability.handler(
		{ name: 'openai-api-key', package_id: 'pkg-mail' },
		ctx,
	)
	expect(additional.status).toBe('approval_required')
	expect(additional.allowed_packages).toEqual(['pkg-notes'])
	expect(additional.approval_url).toBe(
		'https://kody.codes/account/secrets/user/openai-api-key?package_id=pkg-mail&package=mail',
	)
	expect(await allowedPackagesFor(env, userId, 'openai-api-key')).toEqual([
		'pkg-notes',
	])

	const missingPackage = await secretLockCapability
		.handler({ name: 'openai-api-key', package_id: 'missing' }, ctx)
		.then(
			() => null,
			(error: unknown) => error,
		)
	expect(missingPackage).toBeInstanceOf(McpCallerError)
	expect((missingPackage as Error).message).toContain('Saved package not found')

	const missingSecret = await secretLockCapability
		.handler({ name: 'missing-secret', package_id: 'pkg-notes' }, ctx)
		.then(
			() => null,
			(error: unknown) => error,
		)
	expect(missingSecret).toBeInstanceOf(McpCallerError)
	expect((missingSecret as Error).message).toContain(
		'Secret not found for this scope.',
	)
	expect(await allowedPackagesFor(env, userId, 'openai-api-key')).toEqual([
		'pkg-notes',
	])
})
