import { expect, test, vi } from 'vitest'
import * as needsClosure from '#worker/credentials/credential-needs-closure.ts'
import {
	ownCredentialNeeds,
	type CredentialNeed,
} from '#worker/credentials/credential-needs.ts'
import { writePublishedSourceSnapshot } from '#worker/package-runtime/published-runtime-artifacts.ts'
import { getEntitySourceById } from '#worker/repo/entity-sources.ts'
import {
	mappingFixtureBaseUrl,
	setupPackageCredentialMappingFixture,
} from '#worker/test-support/package-credential-mapping-fixture.ts'
import { computePackageCapabilitySet } from './compute-package-capability-set.ts'
import { sourceFilesUsePackageStorage } from './package-storage-use.ts'

const mocks = vi.hoisted(() => ({
	loadPackageManifestBySourceId: vi.fn(),
}))

vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageManifestBySourceId: mocks.loadPackageManifestBySourceId,
}))

const publishedCommit = 'commit-1'

async function setup(input: {
	kody?: Record<string, unknown>
	files?: Record<string, string> | null
	closure?: Array<CredentialNeed>
}) {
	const t = await setupPackageCredentialMappingFixture({
		loadPackageManifestBySourceId: mocks.loadPackageManifestBySourceId,
	})
	await t.db
		.prepare(
			`INSERT INTO entity_sources (
				id, user_id, entity_kind, entity_id, repo_id, published_commit,
				manifest_path, source_root, created_at, updated_at
			) VALUES (?, ?, 'package', ?, ?, ?, 'package.json', '/', ?, ?)`,
		)
		.bind(
			t.savedPackage.sourceId,
			t.acmeId,
			t.savedPackage.id,
			`repo-${t.savedPackage.id}`,
			publishedCommit,
			'2026-10-13T00:00:00.000Z',
			'2026-10-13T00:00:00.000Z',
		)
		.run()
	const manifest = {
		name: '@acme/digest',
		kody: { id: 'digest', description: 'digest', ...input.kody },
	}
	mocks.loadPackageManifestBySourceId.mockResolvedValue({ manifest })
	vi.spyOn(needsClosure, 'loadPublishedCredentialNeeds').mockResolvedValue(
		input.closure ??
			ownCredentialNeeds(
				input.kody?.credentials as Parameters<typeof ownCredentialNeeds>[0],
			),
	)
	if (input.files !== null) {
		const source = await getEntitySourceById(t.db, t.savedPackage.sourceId)
		await writePublishedSourceSnapshot({
			env: t.env,
			source: source!,
			files: {
				'package.json': JSON.stringify(manifest),
				'app/router.ts': 'export default { fetch: () => new Response("hi") }',
				...input.files,
			},
		})
	}
	// Account-wide credentials the package never declares. Self-authored
	// packages can read these implicitly, which is not a declared need.
	const unrelated = [
		await t.storeKey('paypalClientId', 'paypal'),
		await t.storeKey('stripeCourseSecretKey', 'stripe'),
		await t.storeKey('discordOfficialGatewayWebhookMessageCreated', 'discord'),
	]
	const compute = () =>
		computePackageCapabilitySet({
			env: t.env,
			ownerUserId: t.acmeId,
			packageId: t.savedPackage.id,
			packageKodyId: t.savedPackage.kodyId,
			sourceId: t.savedPackage.sourceId,
			requestUrl: mappingFixtureBaseUrl,
			publishedCommit,
		})
	return { ...t, unrelated, compute }
}

test('a package that declares nothing reaches no credentials and no storage, even with many account credentials', async () => {
	const t = await setup({})

	const { capabilitySet } = await t.compute()

	expect(capabilitySet.entries).toEqual([])
})

test('a declared credential need lists only the credentials that fill it', async () => {
	const t = await setup({
		kody: {
			credentials: {
				resend: { description: 'Send the digest' },
			},
		},
	})
	const resendId = await t.storeKey('RESEND_KEY', 'resend')

	const { capabilitySet } = await t.compute()

	expect(capabilitySet.entries).toEqual([
		expect.objectContaining({
			kind: 'credential',
			credentialId: resendId,
			name: 'RESEND_KEY',
			source: 'need',
			needKey: 'resend',
			credentialKind: 'secret',
			hosts: ['api.example.com'],
			via: ['digest'],
		}),
	])
	for (const id of t.unrelated) {
		expect(
			capabilitySet.entries.map((entry) => entry.credentialId),
		).not.toContain(id)
	}
})

test('a credential mapped to a declared need is listed even when its provider would not auto-resolve', async () => {
	const t = await setup({
		kody: {
			credentials: {
				resend: { description: 'Send the digest' },
			},
		},
	})
	const [, mappedId] = t.unrelated
	const now = '2026-10-13T00:00:00.000Z'
	await t.db
		.prepare(
			`INSERT INTO credential_mappings (
				id, org_id, package_id, need_key, target, credential_ids_json,
				created_at, updated_at
			) VALUES (?, ?, ?, 'resend', 'org', ?, ?, ?)`,
		)
		.bind(
			'mapping-1',
			t.acmeId,
			t.savedPackage.id,
			JSON.stringify([mappedId]),
			now,
			now,
		)
		.run()

	const before = await t.compute()
	expect(before.capabilitySet.entries).toEqual([
		expect.objectContaining({
			kind: 'credential',
			credentialId: mappedId,
			source: 'need',
			needKey: 'resend',
		}),
	])

	await t.db
		.prepare(`UPDATE credential_mappings SET credential_ids_json = ?`)
		.bind(JSON.stringify([]))
		.run()
	expect((await t.compute()).capabilitySet.fingerprint).not.toBe(
		before.capabilitySet.fingerprint,
	)
})

test('a need inherited from a dependency lists the credential mapped to it on this package', async () => {
	const t = await setup({
		closure: [
			{
				key: 'chat',
				provider: 'slack',
				description: 'Post the digest',
				multiple: false,
			},
		],
	})
	const [mappedId] = t.unrelated
	const now = '2026-10-13T00:00:00.000Z'
	await t.db
		.prepare(
			`INSERT INTO credential_mappings (
				id, org_id, package_id, need_key, target, credential_ids_json,
				created_at, updated_at
			) VALUES ('mapping-chat', ?, ?, 'chat', 'org', ?, ?, ?)`,
		)
		.bind(t.acmeId, t.savedPackage.id, JSON.stringify([mappedId]), now, now)
		.run()

	expect((await t.compute()).capabilitySet.entries).toEqual([
		expect.objectContaining({
			kind: 'credential',
			credentialId: mappedId,
			source: 'need',
			needKey: 'chat',
		}),
	])
})

test('a secret mount and an explicit grant to this package are listed; other credentials are not', async () => {
	const t = await setup({
		kody: {
			secretMounts: { mail: { name: 'MAIL_TOKEN', scope: 'user' } },
		},
	})
	const mailId = await t.storeKey('MAIL_TOKEN', 'mailer')
	const grantedId = await t.storeKey('GRANTED_TOKEN', 'granted')
	await t.db
		.prepare(`UPDATE secret_entries SET allowed_packages = ? WHERE id = ?`)
		.bind(JSON.stringify([t.savedPackage.id]), grantedId)
		.run()

	const { capabilitySet } = await t.compute()

	expect(
		capabilitySet.entries.map((entry) => [entry.credentialId, entry.source]),
	).toEqual(
		expect.arrayContaining([
			[mailId, 'mount'],
			[grantedId, 'grant'],
		]),
	)
	expect(capabilitySet.entries).toHaveLength(2)
})

test('package storage is listed when the published source uses it, or when the source cannot be read', async () => {
	const uses = await setup({
		files: {
			'app/store.ts':
				"import { packageStorage } from 'kody:runtime'\nexport const store = packageStorage()",
		},
	})
	expect((await uses.compute()).capabilitySet.entries).toEqual([
		expect.objectContaining({
			kind: 'storage',
			storageId: uses.savedPackage.id,
		}),
	])

	const unknown = await setup({ files: null })
	expect((await unknown.compute()).capabilitySet.entries).toEqual([
		expect.objectContaining({ kind: 'storage' }),
	])
})

test('the fingerprint ignores account credentials the package does not declare', async () => {
	const t = await setup({})
	const before = (await t.compute()).capabilitySet.fingerprint

	await t.storeKey('anotherAccountKey', 'other')

	expect((await t.compute()).capabilitySet.fingerprint).toBe(before)
})

test('storage detection reads module files, not browser storage or type declarations', () => {
	expect(
		sourceFilesUsePackageStorage({
			'app/game.ts': "localStorage.setItem('hi', '1')",
			'types/runtime.d.ts': 'export declare function packageStorage(): unknown',
			'README.md': 'Uses packageStorage() for nothing.',
		}),
	).toBe(false)
	expect(
		sourceFilesUsePackageStorage({
			'src/index.ts': 'await kody.storageQuery({ storage_id: id, sql })',
		}),
	).toBe(true)
	expect(
		sourceFilesUsePackageStorage({
			'src/index.ts': "const op = 'storage' + 'Query'\nawait kody?.[op]({})",
		}),
	).toBe(true)
})
