import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { applyAllMigrations as applyRepositoryMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { saveSecret } from '#mcp/secrets/service.ts'
import * as shareGrants from '#worker/package-registry/share-grants.ts'
import { readDeclaredSecretProviderId } from './declared-provider.ts'
import { clearProviderSecretCacheForTests } from './cache.ts'
import {
	createBrokenProviderRefMessage,
	createMissingProviderBindingMessage,
	createMissingProviderDoorSecretMessage,
	createProviderHostDeniedMessage,
	createProviderNoWebsitesMessage,
	createProviderPackageNotGrantedMessage,
} from './errors.ts'
import { providerHostsAllowRequestHost } from './hosts.ts'
import {
	enableSecretProvidersForTests,
	isSecretProvidersEnabled,
	secretProvidersDisabledMessage,
} from './flag.ts'
import {
	bindSecretProvider,
	grantSecretProviderToPackage,
	inspectSecretProviderPackageGrant,
	resolveProviderSecret,
	revokeSecretProviderGrant,
	unbindSecretProvider,
	type SecretProviderInvoker,
} from './service.ts'

vi.mock('./declared-provider.ts', () => ({
	readDeclaredSecretProviderId: vi.fn(),
}))

const migrationsDirectory = new URL('../../../../migrations/', import.meta.url)
const itemId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const canonicalRef = `i/${itemId}/password`
const providerId = '1password'

async function createHarness() {
	clearProviderSecretCacheForTests()
	const sqlite = new DatabaseSync(':memory:')
	applyRepositoryMigrations(sqlite, migrationsDirectory)
	const env = {
		APP_DB: createD1FromSqlite(sqlite),
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
		...createInMemoryUserMeterEnv().env,
	} as Env
	seedUser(sqlite, { id: 1, stableUserId: 'user-owner' })
	seedUser(sqlite, { id: 2, stableUserId: 'user-guest' })
	await enableSecretProvidersForTests(env.APP_DB)
	return { sqlite, env }
}

function seedUser(
	sqlite: DatabaseSync,
	input: { id: number; stableUserId: string },
) {
	sqlite
		.prepare(
			`INSERT INTO users (
				id, username, email, stable_user_id, password_hash, email_verified_at
			) VALUES (?, ?, ?, ?, 'x', CURRENT_TIMESTAMP)`,
		)
		.run(
			input.id,
			input.stableUserId,
			`${input.stableUserId}@example.com`,
			input.stableUserId,
		)
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

async function seedDoorSecret(env: Env, userId: string) {
	await saveSecret({
		env,
		userId,
		scope: 'user',
		name: 'onePasswordServiceAccountToken',
		value: 'op-sa-token',
	})
}

async function seedBinding(
	env: Env,
	input: { userId: string; packageId: string },
) {
	await env.APP_DB.prepare(
		`INSERT INTO secret_provider_bindings (
			user_id, provider_id, package_id, door_secret_name, config_json
		) VALUES (?, ?, ?, ?, '{}')`,
	)
		.bind(
			input.userId,
			providerId,
			input.packageId,
			'onePasswordServiceAccountToken',
		)
		.run()
}

test('provider resolve grants, hosts, cache, owner execute, share owner binding, and fail-closed paths', async () => {
	const { sqlite, env } = await createHarness()
	const ownerId = 'user-owner'
	const guestId = 'user-guest'
	seedPackage(sqlite, { id: 'pkg-provider', userId: ownerId, kodyId: 'op' })
	seedPackage(sqlite, { id: 'pkg-consumer', userId: ownerId, kodyId: 'deploy' })
	await seedDoorSecret(env, ownerId)
	await seedBinding(env, { userId: ownerId, packageId: 'pkg-provider' })
	vi.mocked(readDeclaredSecretProviderId).mockResolvedValue(providerId)

	let providerCalls = 0
	const invokeProvider: SecretProviderInvoker = async (input) => {
		providerCalls += 1
		if (input.action === 'canonicalize') {
			return { canonicalRef }
		}
		return {
			value: 'item-password',
			hosts: ['https://app.example.com/login'],
		}
	}

	await expect(
		resolveProviderSecret({
			env,
			baseUrl: 'https://kody.example',
			userId: ownerId,
			provider: providerId,
			ref: `op://Personal/${itemId}/password`,
			authorityPackageId: 'pkg-consumer',
			invokeProvider,
		}),
	).rejects.toThrow(
		createProviderPackageNotGrantedMessage({
			providerId,
			canonicalRef,
			packageName: 'deploy',
			approvalUrl:
				'https://kody.example/account/secret-providers/approve?provider=1password&ref=i%2Fbbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb%2Fpassword&package_id=pkg-consumer&package=deploy',
		}),
	)
	expect(providerCalls).toBe(0)

	const ownerExecute = await resolveProviderSecret({
		env,
		baseUrl: 'https://kody.example',
		userId: ownerId,
		provider: providerId,
		ref: `op://Personal/${itemId}/password`,
		invokeProvider,
	})
	expect(ownerExecute).toMatchObject({
		provider: providerId,
		canonicalRef,
		value: 'item-password',
		hosts: ['app.example.com'],
	})
	expect(providerCalls).toBe(1)
	expect(
		providerHostsAllowRequestHost(ownerExecute.hosts, 'app.example.com'),
	).toBe(true)
	expect(
		providerHostsAllowRequestHost(ownerExecute.hosts, 'other.example.com'),
	).toBe(false)
	expect(
		createProviderHostDeniedMessage({
			providerId,
			host: 'other.example.com',
		}),
	).toContain('other.example.com')

	const cached = await resolveProviderSecret({
		env,
		baseUrl: 'https://kody.example',
		userId: ownerId,
		provider: providerId,
		ref: `i/${itemId}/password`,
		invokeProvider,
	})
	expect(cached.value).toBe('item-password')
	expect(providerCalls).toBe(1)

	await grantSecretProviderToPackage({
		env,
		userId: ownerId,
		providerId,
		ref: canonicalRef,
		packageId: 'pkg-consumer',
	})
	const granted = await inspectSecretProviderPackageGrant({
		env,
		userId: ownerId,
		providerId,
		ref: `op://Personal/${itemId}/password`,
		packageId: 'pkg-consumer',
	})
	expect(granted.alreadyGranted).toBe(true)

	clearProviderSecretCacheForTests()
	const packageUse = await resolveProviderSecret({
		env,
		baseUrl: 'https://kody.example',
		userId: ownerId,
		provider: providerId,
		ref: canonicalRef,
		authorityPackageId: 'pkg-consumer',
		invokeProvider,
	})
	expect(packageUse.value).toBe('item-password')
	expect(providerCalls).toBe(2)

	const shareInvoker: SecretProviderInvoker = async (input) => {
		expect(input.ownerUserId).toBe(ownerId)
		expect(input.doorSecretValue).toBe('op-sa-token')
		return {
			value: 'shared-password',
			hosts: ['app.example.com'],
		}
	}
	vi.spyOn(shareGrants, 'resolvePackageStorageOwnerUserId').mockResolvedValue(
		ownerId,
	)
	clearProviderSecretCacheForTests()
	const shared = await resolveProviderSecret({
		env,
		baseUrl: 'https://kody.example',
		userId: guestId,
		provider: providerId,
		ref: canonicalRef,
		authorityPackageId: 'pkg-consumer',
		invokeProvider: shareInvoker,
	})
	expect(shared.value).toBe('shared-password')

	clearProviderSecretCacheForTests()
	await expect(
		resolveProviderSecret({
			env,
			baseUrl: 'https://kody.example',
			userId: ownerId,
			provider: providerId,
			ref: canonicalRef,
			invokeProvider: async () => ({ value: 'x', hosts: [] }),
		}),
	).rejects.toThrow(createProviderNoWebsitesMessage(providerId))

	await expect(
		resolveProviderSecret({
			env,
			baseUrl: 'https://kody.example',
			userId: ownerId,
			provider: providerId,
			ref: 'op://Vault/Item/password',
			invokeProvider: async () => ({ canonicalRef: 'not-canonical' }),
		}),
	).rejects.toThrow(createBrokenProviderRefMessage(providerId))

	await env.APP_DB.prepare(`DELETE FROM secret_entries WHERE name = ?`)
		.bind('onePasswordServiceAccountToken')
		.run()
	clearProviderSecretCacheForTests()
	await expect(
		resolveProviderSecret({
			env,
			baseUrl: 'https://kody.example',
			userId: ownerId,
			provider: providerId,
			ref: canonicalRef,
			invokeProvider,
		}),
	).rejects.toThrow(
		createMissingProviderDoorSecretMessage({
			providerId,
			doorSecretName: 'onePasswordServiceAccountToken',
		}),
	)
})

test('revoke drops a package grant before the next resolve', async () => {
	const { sqlite, env } = await createHarness()
	const ownerId = 'user-owner'
	seedPackage(sqlite, { id: 'pkg-provider', userId: ownerId, kodyId: 'op' })
	seedPackage(sqlite, { id: 'pkg-consumer', userId: ownerId, kodyId: 'deploy' })
	await seedDoorSecret(env, ownerId)
	await seedBinding(env, { userId: ownerId, packageId: 'pkg-provider' })
	vi.mocked(readDeclaredSecretProviderId).mockResolvedValue(providerId)
	await grantSecretProviderToPackage({
		env,
		userId: ownerId,
		providerId,
		ref: canonicalRef,
		packageId: 'pkg-consumer',
	})
	await revokeSecretProviderGrant({
		env,
		userId: ownerId,
		providerId,
		ref: canonicalRef,
		packageId: 'pkg-consumer',
	})
	const granted = await inspectSecretProviderPackageGrant({
		env,
		userId: ownerId,
		providerId,
		ref: canonicalRef,
		packageId: 'pkg-consumer',
	})
	expect(granted.alreadyGranted).toBe(false)
	let providerCalls = 0
	await expect(
		resolveProviderSecret({
			env,
			baseUrl: 'https://kody.example',
			userId: ownerId,
			provider: providerId,
			ref: canonicalRef,
			authorityPackageId: 'pkg-consumer',
			invokeProvider: async () => {
				providerCalls += 1
				return { value: 'should-not-resolve', hosts: ['app.example.com'] }
			},
		}),
	).rejects.toThrow(
		createProviderPackageNotGrantedMessage({
			providerId,
			canonicalRef,
			packageName: 'deploy',
			approvalUrl:
				'https://kody.example/account/secret-providers/approve?provider=1password&ref=i%2Fbbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb%2Fpassword&package_id=pkg-consumer&package=deploy',
		}),
	)
	expect(providerCalls).toBe(0)
})

test('flag off treats provider placeholders as unsupported and never calls the provider', async () => {
	clearProviderSecretCacheForTests()
	const sqlite = new DatabaseSync(':memory:')
	applyRepositoryMigrations(sqlite, migrationsDirectory)
	const env = {
		APP_DB: createD1FromSqlite(sqlite),
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
		...createInMemoryUserMeterEnv().env,
	} as Env
	const ownerId = 'user-owner'
	seedPackage(sqlite, { id: 'pkg-provider', userId: ownerId, kodyId: 'op' })
	await seedDoorSecret(env, ownerId)
	await seedBinding(env, { userId: ownerId, packageId: 'pkg-provider' })
	vi.mocked(readDeclaredSecretProviderId).mockResolvedValue(providerId)
	let providerCalls = 0
	await expect(
		resolveProviderSecret({
			env,
			baseUrl: 'https://kody.example',
			userId: ownerId,
			provider: providerId,
			ref: canonicalRef,
			invokeProvider: async () => {
				providerCalls += 1
				return { value: 'should-not-resolve', hosts: ['app.example.com'] }
			},
		}),
	).rejects.toThrow(secretProvidersDisabledMessage)
	expect(providerCalls).toBe(0)
})

test('flag evaluation is fail-closed when the account cannot be resolved', async () => {
	const sqlite = new DatabaseSync(':memory:')
	applyRepositoryMigrations(sqlite, migrationsDirectory)
	const db = createD1FromSqlite(sqlite)
	await enableSecretProvidersForTests(db)

	await expect(
		isSecretProvidersEnabled({ db, userId: null, stableUserId: null }),
	).resolves.toBe(false)
	await expect(
		isSecretProvidersEnabled({
			db,
			stableUserId: 'missing-account',
		}),
	).resolves.toBe(false)

	seedUser(sqlite, { id: 10, stableUserId: 'user-owner' })
	await expect(
		isSecretProvidersEnabled({
			db,
			stableUserId: 'user-owner',
		}),
	).resolves.toBe(true)

	clearProviderSecretCacheForTests()
	const env = {
		APP_DB: db,
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
		...createInMemoryUserMeterEnv().env,
	} as Env
	seedPackage(sqlite, { id: 'pkg-provider', userId: 'ghost', kodyId: 'op' })
	await seedDoorSecret(env, 'ghost')
	await seedBinding(env, { userId: 'ghost', packageId: 'pkg-provider' })
	vi.mocked(readDeclaredSecretProviderId).mockResolvedValue(providerId)
	let providerCalls = 0
	await expect(
		resolveProviderSecret({
			env,
			baseUrl: 'https://kody.example',
			userId: 'ghost',
			provider: providerId,
			ref: canonicalRef,
			invokeProvider: async () => {
				providerCalls += 1
				return { value: 'should-not-resolve', hosts: ['app.example.com'] }
			},
		}),
	).rejects.toThrow(secretProvidersDisabledMessage)
	expect(providerCalls).toBe(0)
})

test('rebind to a different package drops grants and the provider cache', async () => {
	const { sqlite, env } = await createHarness()
	const ownerId = 'user-owner'
	seedPackage(sqlite, { id: 'pkg-provider', userId: ownerId, kodyId: 'op' })
	seedPackage(sqlite, { id: 'pkg-provider-2', userId: ownerId, kodyId: 'op-2' })
	seedPackage(sqlite, { id: 'pkg-consumer', userId: ownerId, kodyId: 'deploy' })
	await seedDoorSecret(env, ownerId)
	await seedBinding(env, { userId: ownerId, packageId: 'pkg-provider' })
	vi.mocked(readDeclaredSecretProviderId).mockResolvedValue(providerId)
	await grantSecretProviderToPackage({
		env,
		userId: ownerId,
		providerId,
		ref: canonicalRef,
		packageId: 'pkg-consumer',
	})

	let providerCalls = 0
	const invokeProvider: SecretProviderInvoker = async (input) => {
		providerCalls += 1
		if (input.action === 'canonicalize') {
			return { canonicalRef }
		}
		return {
			value: 'item-password',
			hosts: ['app.example.com'],
		}
	}
	await resolveProviderSecret({
		env,
		baseUrl: 'https://kody.example',
		userId: ownerId,
		provider: providerId,
		ref: canonicalRef,
		invokeProvider,
	})
	expect(providerCalls).toBe(1)

	await bindSecretProvider({
		env,
		baseUrl: 'https://kody.example',
		userId: ownerId,
		providerId,
		packageId: 'pkg-provider',
		doorSecretName: 'onePasswordServiceAccountToken',
	})
	expect(
		(
			await inspectSecretProviderPackageGrant({
				env,
				userId: ownerId,
				providerId,
				ref: canonicalRef,
				packageId: 'pkg-consumer',
			})
		).alreadyGranted,
	).toBe(true)
	await resolveProviderSecret({
		env,
		baseUrl: 'https://kody.example',
		userId: ownerId,
		provider: providerId,
		ref: canonicalRef,
		invokeProvider,
	})
	expect(providerCalls).toBe(2)

	await bindSecretProvider({
		env,
		baseUrl: 'https://kody.example',
		userId: ownerId,
		providerId,
		packageId: 'pkg-provider-2',
		doorSecretName: 'onePasswordServiceAccountToken',
	})
	expect(
		(
			await inspectSecretProviderPackageGrant({
				env,
				userId: ownerId,
				providerId,
				ref: canonicalRef,
				packageId: 'pkg-consumer',
			})
		).alreadyGranted,
	).toBe(false)
	await expect(
		resolveProviderSecret({
			env,
			baseUrl: 'https://kody.example',
			userId: ownerId,
			provider: providerId,
			ref: canonicalRef,
			authorityPackageId: 'pkg-consumer',
			invokeProvider,
		}),
	).rejects.toThrow(
		createProviderPackageNotGrantedMessage({
			providerId,
			canonicalRef,
			packageName: 'deploy',
			approvalUrl:
				'https://kody.example/account/secret-providers/approve?provider=1password&ref=i%2Fbbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb%2Fpassword&package_id=pkg-consumer&package=deploy',
		}),
	)
	expect(providerCalls).toBe(2)
})

test('unbind drops grants and refuses the next resolve', async () => {
	const { sqlite, env } = await createHarness()
	const ownerId = 'user-owner'
	seedPackage(sqlite, { id: 'pkg-provider', userId: ownerId, kodyId: 'op' })
	seedPackage(sqlite, { id: 'pkg-consumer', userId: ownerId, kodyId: 'deploy' })
	await seedDoorSecret(env, ownerId)
	await seedBinding(env, { userId: ownerId, packageId: 'pkg-provider' })
	vi.mocked(readDeclaredSecretProviderId).mockResolvedValue(providerId)
	await grantSecretProviderToPackage({
		env,
		userId: ownerId,
		providerId,
		ref: canonicalRef,
		packageId: 'pkg-consumer',
	})
	await unbindSecretProvider({
		env,
		userId: ownerId,
		providerId,
	})
	await expect(
		inspectSecretProviderPackageGrant({
			env,
			userId: ownerId,
			providerId,
			ref: canonicalRef,
			packageId: 'pkg-consumer',
		}),
	).rejects.toThrow(createMissingProviderBindingMessage(providerId))
	let providerCalls = 0
	await expect(
		resolveProviderSecret({
			env,
			baseUrl: 'https://kody.example',
			userId: ownerId,
			provider: providerId,
			ref: canonicalRef,
			invokeProvider: async () => {
				providerCalls += 1
				return { value: 'should-not-resolve', hosts: ['app.example.com'] }
			},
		}),
	).rejects.toThrow(createMissingProviderBindingMessage(providerId))
	expect(providerCalls).toBe(0)
})

test('grant and inspect require a binding before offering Allow', async () => {
	const { sqlite, env } = await createHarness()
	const ownerId = 'user-owner'
	seedPackage(sqlite, { id: 'pkg-consumer', userId: ownerId, kodyId: 'deploy' })
	await expect(
		grantSecretProviderToPackage({
			env,
			userId: ownerId,
			providerId,
			ref: canonicalRef,
			packageId: 'pkg-consumer',
		}),
	).rejects.toThrow(createMissingProviderBindingMessage(providerId))
	await expect(
		inspectSecretProviderPackageGrant({
			env,
			userId: ownerId,
			providerId,
			ref: canonicalRef,
			packageId: 'pkg-consumer',
		}),
	).rejects.toThrow(createMissingProviderBindingMessage(providerId))
})
