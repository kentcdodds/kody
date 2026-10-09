import { readFile } from 'node:fs/promises'

import { expect, test } from 'vitest'

import {
	buildVerificationQueries,
	parseAndVerifyManifest,
	parseBaseline,
	parseRestoreTrustRegistry,
	runD1RestoreDrill,
	verifyRows,
} from './d1-restore-drill.ts'
import {
	assertRequestedDatabase,
	manifestPublicKeyRegistryPath,
	migrationsDirectoryForDatabase,
	parseArguments,
	restoreBaselineRegistryPath,
	restoreTrustRegistryPath,
} from './d1-restore-drill-cli.ts'
import {
	backupBytes,
	createAdapters,
	createBaseline,
	createManifest,
	createTrustRegistry,
	drillInput,
	manifestFixture,
	manifestKeyRegistry,
	productionAccountId,
	productionUuid,
	signManifestPayload,
	targetAccountId,
	targetUuid,
} from './disaster-recovery-test-support.ts'
import { canonicalJson, sha256 } from './canonical-json.ts'
import {
	parseTrustedManifestPublicKeyRegistry,
	parseTrustedRestoreBaselineRegistry,
} from './restore-trust.ts'

const jobsDatabaseId = '5410331e-4d25-47e4-a1e5-a248f7cc764c'

function manifestInput(fixture: ReturnType<typeof manifestFixture>) {
	return {
		manifestBytes: fixture.bytes,
		expectedManifestSha256: fixture.checksum,
	}
}

async function expectDrillRejected(
	overrides: Record<string, unknown>,
	message: string,
) {
	const adapters = createAdapters()
	await expect(
		runD1RestoreDrill(drillInput(overrides), adapters),
	).rejects.toThrow(message)
	expect(adapters.createTarget).not.toHaveBeenCalled()
}

function verifyManifestJson(manifest: unknown) {
	const bytes = new TextEncoder().encode(JSON.stringify(manifest))
	return () => parseAndVerifyManifest(bytes, sha256(bytes), manifestKeyRegistry)
}

function cliArgs(...extra: Array<string>) {
	return parseArguments([
		'--manifest',
		'manifest.json',
		'--manifest-sha256',
		'0'.repeat(64),
		'--backup',
		'backup.sql',
		'--baseline-id',
		'production-baseline-2026',
		'--target-account-id',
		targetAccountId,
		...extra,
	])
}

test('D1 drill verifies manifest, SQL evidence, and isolation rows before live creation', async () => {
	const fixture = manifestFixture()
	expect(
		parseAndVerifyManifest(
			fixture.bytes,
			fixture.checksum,
			manifestKeyRegistry,
		),
	).toEqual(fixture.manifest)
	const liveRejections: Array<[Record<string, unknown>, string]> = [
		[{ expectedManifestSha256: '0'.repeat(64) }, 'manifest bytes do not match'],
		[
			{
				backupFileEvidence: {
					sizeBytes: backupBytes.byteLength - 1,
					sha256: sha256(backupBytes),
				},
			},
			'local SQL file evidence',
		],
		[
			{
				backupFileEvidence: {
					sizeBytes: backupBytes.byteLength,
					sha256: 'f'.repeat(64),
				},
			},
			'local SQL file evidence',
		],
		[
			manifestInput(manifestFixture({ bytes: 5 * 1024 * 1024 * 1024 })),
			'exceeds the 5 GiB',
		],
	]
	for (const [overrides, message] of liveRejections) {
		await expectDrillRejected({ ...overrides, dryRun: false }, message)
	}

	const baseline = createBaseline({
		isolationChecks: [
			{
				table: 'messages',
				userColumn: 'user_id',
				primaryKeyColumn: 'id',
				users: [
					{
						userId: '1',
						rowCount: 1,
						primaryKeySha256: sha256(canonicalJson(['message-a'])),
					},
					{
						userId: '2',
						rowCount: 1,
						primaryKeySha256: sha256(canonicalJson(['message-b'])),
					},
				],
			},
		],
	})
	const query = buildVerificationQueries(baseline, 'baseline').find(
		(candidate) => candidate.id === 'isolation',
	)
	if (!query) throw new Error('fixture lacks isolation query')
	expect(() =>
		verifyRows(
			query,
			[
				{ table_name: 'messages', user_id: 1, primary_key: 'message-a' },
				{ table_name: 'messages', user_id: 2, primary_key: 'message-b' },
			],
			baseline,
		),
	).not.toThrow()
})

test('restore requires a trusted manifest signature and checked baseline id', async () => {
	const { manifest } = manifestFixture()
	expect(
		verifyManifestJson({
			schemaVersion: manifest.schemaVersion,
			payload: manifest.payload,
		}),
	).toThrow('invalid versioned shape')

	const tampered = structuredClone(manifest)
	tampered.payload.sql.sha256 = 'f'.repeat(64)
	expect(verifyManifestJson(tampered)).toThrow('signature verification failed')

	const unknownKey = structuredClone(manifest)
	unknownKey.payload.signing.keyId = 'unknown-backup-key'
	unknownKey.signature.keyId = 'unknown-backup-key'
	unknownKey.signature.value = signManifestPayload(unknownKey.payload)
	expect(verifyManifestJson(unknownKey)).toThrow('signing key is not trusted')

	await expect(
		runD1RestoreDrill(
			drillInput({
				baseline: createBaseline({ schemaSha256: 'f'.repeat(64) }),
				baselineId: 'operator-baseline',
			}),
			createAdapters(),
		),
	).rejects.toThrow('baseline id is not trusted')
})

test('restore trust registry is exact, pins the reviewed identities, and cannot be replaced by operator assertions', async () => {
	const registryRejections: Array<[unknown, string]> = [
		[{ ...createTrustRegistry(), operatorApproved: true }, 'invalid shape'],
		[
			{
				...createTrustRegistry(),
				productionSources: [
					{
						accountId: productionAccountId,
						databaseId: productionUuid,
						databaseName: 'kody-production',
						purpose: 'production',
					},
				],
			},
			'invalid shape',
		],
		[
			createTrustRegistry({
				drillTargets: [
					{ accountId: 'not-a-cloudflare-account', databaseName: 'kody-drill' },
				],
			}),
			'Cloudflare account ID',
		],
		[
			createTrustRegistry({
				productionSources: [
					{
						accountId: productionAccountId.toUpperCase(),
						databaseId: productionUuid,
						databaseName: 'kody-production',
					},
				],
			}),
			'Cloudflare account ID',
		],
		[
			createTrustRegistry({
				drillTargets: [
					{
						accountId: targetAccountId.toUpperCase(),
						databaseName: 'kody-drill',
					},
				],
			}),
			'Cloudflare account ID',
		],
	]
	for (const [registry, message] of registryRejections) {
		expect(() => parseRestoreTrustRegistry(registry)).toThrow(message)
	}

	const readJson = async (filePath: string): Promise<unknown> =>
		JSON.parse(await readFile(filePath, 'utf8'))
	const checkedRegistry = await readJson(restoreTrustRegistryPath)
	expect(
		parseTrustedManifestPublicKeyRegistry(
			await readJson(manifestPublicKeyRegistryPath),
		).keys,
	).toEqual([
		{
			algorithm: 'Ed25519',
			keyId: 'kody-dr-2026-07',
			publicKeyPem:
				'-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA3jqjPcGTzWefE5PGyRBdUQKAEj7FFGtFIz+223sbt9A=\n-----END PUBLIC KEY-----\n',
		},
	])
	expect(
		parseTrustedRestoreBaselineRegistry(
			await readJson(restoreBaselineRegistryPath),
			parseBaseline,
		).baselines,
	).toEqual([])
	// These exact identities are the reviewed allowlist for restore flows.
	// Changing them requires updating this pin in the same reviewed change.
	expect(parseRestoreTrustRegistry(checkedRegistry)).toEqual({
		schemaVersion: 1,
		productionSources: [
			{
				accountId: 'a99ee2e72728dd52902ef288b7b1447d',
				databaseId: '8c1014d1-6b41-4695-a0a2-159071f0f919',
				databaseName: 'kody',
			},
			{
				accountId: 'a99ee2e72728dd52902ef288b7b1447d',
				databaseId: jobsDatabaseId,
				databaseName: 'kody-jobs',
			},
		],
		drillTargets: [
			{
				accountId: 'a41d50ecaf0ae0f86dd1824ef6729cb2',
				databaseName: 'kody-dr-drill-manual',
			},
		],
	})
	for (const dryRun of [true, false]) {
		await expectDrillRejected(
			{ trustRegistry: checkedRegistry, dryRun },
			'manifest source identity is not approved',
		)
	}
	await expectDrillRejected(
		{
			...manifestInput(
				manifestFixture({
					source: {
						accountId: targetAccountId,
						databaseId: targetUuid,
						databaseName: 'kody-drill',
					},
				}),
			),
			allowlist: [
				{ accountId: targetAccountId, name: 'kody-drill', purpose: 'drill' },
			],
			dryRun: false,
		},
		'manifest source identity is not approved',
	)

	const source = createManifest().payload.source
	await expect(
		runD1RestoreDrill(
			drillInput({
				...manifestInput(
					manifestFixture({
						source: { ...source, accountId: productionAccountId.toUpperCase() },
					}),
				),
				targetAccountId: targetAccountId.toUpperCase(),
			}),
			createAdapters(),
		),
	).resolves.toMatchObject({ dryRun: true })

	expect(() =>
		cliArgs(
			'--allowlist',
			'operator-registry.json',
			'--target-name',
			'kody-drill',
		),
	).toThrow('Unknown argument: --allowlist')
})

test('restore-drill --database selects a configured source and jobs migrations', () => {
	expect(
		cliArgs('--target-name', 'kody-jobs-drill', '--database', 'kody-jobs')
			.database,
	).toBe('kody-jobs')
	expect(() =>
		assertRequestedDatabase('kody-jobs', jobsDatabaseId, 'kody-jobs'),
	).not.toThrow()
	expect(() =>
		assertRequestedDatabase('kody-jobs', jobsDatabaseId, jobsDatabaseId),
	).not.toThrow()
	expect(() =>
		assertRequestedDatabase(
			'kody',
			'8c1014d1-6b41-4695-a0a2-159071f0f919',
			'kody-jobs',
		),
	).toThrow('--database kody-jobs does not match manifest source kody')
	expect(migrationsDirectoryForDatabase('kody')).toMatch(
		/packages\/worker\/migrations\/?$/,
	)
	expect(migrationsDirectoryForDatabase('kody-jobs')).toMatch(
		/packages\/jobs-worker\/migrations\/?$/,
	)
})
