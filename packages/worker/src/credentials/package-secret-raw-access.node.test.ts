/**
 * Real-boundary coverage for `packageSecrets.get` raw access (credentials plan
 * v4, open call 15): migrated APP_DB, real secrets and package grants, and a
 * real parsed manifest. Only a `raw: true` secret slot hands its value to
 * package code; everything else fails before any value is read.
 */
import { DatabaseSync } from 'node:sqlite'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { PackageSecretRawAccessError } from '#mcp/secrets/package-access.ts'
import * as secretService from '#mcp/secrets/service.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { parseAuthoredPackageJson } from '#worker/package-registry/manifest.ts'
import { insertSavedPackage } from '#worker/package-registry/repo.ts'
import * as packageSource from '#worker/package-registry/source.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createAuditTestDb } from '#worker/test-support/create-audit-db.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { attestedPackageStamp, claimedPackageStamp } from './package-stamp.ts'
import { resolveCredential } from './resolve-credential.ts'

vi.mock('cloudflare:workers', async (importOriginal) => ({
	...(await importOriginal<typeof import('cloudflare:workers')>()),
	waitUntil: () => {},
}))

const now = '2026-10-11T00:00:00.000Z'
const values = {
	RAW_KEY: 'raw-slot-value',
	HEADER_KEY: 'header-slot-value',
	LEGACY_KEY: 'legacy-mount-value',
}

async function setup() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	const ownerStableId = testStableUserIdFromEmail('owner@example.com')
	const orgId = ownerIdFromStored(ownerStableId)
	await provisionPersonalOrg(db, {
		stableUserId: ownerStableId,
		username: 'owner',
		createdAt: now,
	})
	const packageId = crypto.randomUUID()
	await insertSavedPackage(
		db,
		{
			id: packageId,
			user_id: orgId,
			name: '@owner/signer',
			kody_id: 'signer',
			description: 'signer',
			tags_json: '[]',
			search_text: null,
			source_id: `source-${packageId}`,
			has_app: 0,
			has_skills: 0,
			hidden: 0,
			is_private: 1,
			created_at: now,
			updated_at: now,
		},
		null,
		{ stamp: false },
	)
	const env = {
		APP_DB: db,
		AUDIT_DB: createAuditTestDb(),
		...createInMemoryUserMeterEnv().env,
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
	} as unknown as Env
	for (const [name, value] of Object.entries(values)) {
		await secretService.saveSecret({
			env,
			userId: orgId,
			scope: 'user',
			name,
			value,
		})
		await secretService.lockSecretToPackage({
			env,
			userId: orgId,
			name,
			packageId,
		})
	}
	vi.spyOn(packageSource, 'loadPackageManifestBySourceId').mockResolvedValue({
		source: {} as packageSource.LoadedPackageManifest['source'],
		manifest: parseAuthoredPackageJson({
			content: JSON.stringify({
				name: '@owner/signer',
				exports: { '.': './index.ts' },
				kody: {
					description: 'Signs requests.',
					credentials: {
						RAW_KEY: {
							kind: 'secret',
							provider: 'aws',
							description: 'Signing key.',
							raw: true,
						},
						HEADER_KEY: {
							kind: 'secret',
							provider: 'resend',
							description: 'API key.',
							placement: {
								header: 'Authorization',
								template: 'Bearer {value}',
							},
						},
						GOOGLE: {
							kind: 'oauth',
							provider: 'google',
							description: 'Google.',
						},
					},
					secretMounts: { LEGACY_KEY: { name: 'LEGACY_KEY', scope: 'user' } },
				},
			}),
			mode: 'published',
		}),
	})
	const request = deriveRequestContext({
		user: { userId: personIdFromStored(ownerStableId), username: 'owner' },
		source: { kind: 'mcp-oauth' },
		orgBinding: { org: { id: orgId, slug: 'owner' }, role: 'owner' },
	})
	const callerContext = createMcpCallerContext({
		source: { kind: 'mcp-oauth' },
		baseUrl: 'https://example.com',
		user: {
			userId: personIdFromStored(ownerStableId),
			username: 'owner',
			email: 'owner@example.com',
			displayName: 'Owner',
		},
		storageContext: {
			sessionId: null,
			appId: null,
			packageId,
			storageId: null,
		},
	})
	const read = (
		alias: string,
		access: 'raw' | 'presence',
		stamp: typeof attestedPackageStamp = attestedPackageStamp,
	) =>
		resolveCredential({
			env,
			orgId,
			actor: request,
			packageStamp: stamp(packageId),
			baseUrl: 'https://example.com',
			credential: {
				use: 'package-secret-mount',
				alias,
				access,
				callerContext,
			},
		})
	return { read }
}

test('leak: packageSecrets.get without a raw slot fails with guidance and reads no value', async () => {
	const t = await setup()
	const resolveSecret = vi.spyOn(secretService, 'resolveSecret')

	await expect(t.read('RAW_KEY', 'raw')).resolves.toMatchObject({
		name: 'RAW_KEY',
		value: values.RAW_KEY,
	})
	expect(resolveSecret).toHaveBeenCalledTimes(1)
	resolveSecret.mockClear()

	const refusals: Array<[string, RegExp]> = [
		[
			'HEADER_KEY',
			/slot "HEADER_KEY" of @owner\/signer does not\. Send the value with \{\{secret:HEADER_KEY\}\} in the slot's declared header .* or declare "raw": true on the slot/,
		],
		[
			'GOOGLE',
			/slot "GOOGLE" of @owner\/signer has kind "oauth"\. OAuth tokens and MCP connections are never handed to package code/,
		],
		[
			'LEGACY_KEY',
			/@owner\/signer has no slot "LEGACY_KEY"\. kody\.secretMounts aliases no longer resolve through packageSecrets\.get\. Declare it in package\.json/,
		],
		['UNKNOWN', /@owner\/signer has no slot "UNKNOWN"\. Declare it/],
	]
	for (const [alias, message] of refusals) {
		const error = await t.read(alias, 'raw').then(
			() => null,
			(cause: unknown) => cause,
		)
		expect(error).toBeInstanceOf(PackageSecretRawAccessError)
		expect((error as Error).message).toMatch(
			/^packageSecrets\.get returns a value only from a kody\.credentials secret slot that declares "raw": true/,
		)
		expect((error as Error).message).toMatch(message)
		for (const value of Object.values(values)) {
			expect((error as Error).message).not.toContain(value)
		}
	}
	expect(resolveSecret).not.toHaveBeenCalled()

	// `has` answers presence for any secret slot or legacy mount, never a value.
	for (const alias of ['RAW_KEY', 'HEADER_KEY', 'LEGACY_KEY']) {
		await expect(t.read(alias, 'presence')).resolves.toMatchObject({
			value: null,
		})
	}
})

test('leak: a claimed package stamp never reads a raw slot', async () => {
	const t = await setup()
	const resolveSecret = vi.spyOn(secretService, 'resolveSecret')
	const error = await t.read('RAW_KEY', 'raw', claimedPackageStamp).then(
		() => null,
		(cause: unknown) => cause,
	)
	expect(error).toBeInstanceOf(PackageSecretRawAccessError)
	expect((error as Error).message).toMatch(
		/raw slot "RAW_KEY" of @owner\/signer only when Kody runs the package's code itself\. Local execute \(--local\)/,
	)
	expect((error as Error).message).not.toContain(values.RAW_KEY)
	expect(resolveSecret).not.toHaveBeenCalled()
	await expect(
		t.read('RAW_KEY', 'presence', claimedPackageStamp),
	).resolves.toMatchObject({ value: null })
})
