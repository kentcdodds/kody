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
	manifestPublicKeyRegistryPath,
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

test('D1 drill verifies immutable manifest and supplied SQL file evidence before any live creation', async () => {
	const fixture = manifestFixture()
	expect(
		parseAndVerifyManifest(
			fixture.bytes,
			fixture.checksum,
			manifestKeyRegistry,
		),
	).toEqual(fixture.manifest)
	const adapters = createAdapters()
	await expect(
		runD1RestoreDrill(
			drillInput({ expectedManifestSha256: '0'.repeat(64), dryRun: false }),
			adapters,
		),
	).rejects.toThrow('manifest bytes do not match')
	await expect(
		runD1RestoreDrill(
			drillInput({
				backupFileEvidence: {
					sizeBytes: backupBytes.byteLength - 1,
					sha256: sha256(backupBytes),
				},
				dryRun: false,
			}),
			adapters,
		),
	).rejects.toThrow('local SQL file evidence')
	await expect(
		runD1RestoreDrill(
			drillInput({
				backupFileEvidence: {
					sizeBytes: backupBytes.byteLength,
					sha256: 'f'.repeat(64),
				},
				dryRun: false,
			}),
			adapters,
		),
	).rejects.toThrow('local SQL file evidence')
	const oversized = manifestFixture({
		bytes: 5 * 1024 * 1024 * 1024,
	})
	await expect(
		runD1RestoreDrill(
			drillInput({
				manifestBytes: oversized.bytes,
				expectedManifestSha256: oversized.checksum,
				dryRun: false,
			}),
			adapters,
		),
	).rejects.toThrow('exceeds the 5 GiB')
	expect(adapters.createTarget).not.toHaveBeenCalled()
})

test('restore requires a trusted manifest signature and checked baseline id', async () => {
	const fixture = manifestFixture()
	const unsignedBytes = new TextEncoder().encode(
		JSON.stringify({
			schemaVersion: fixture.manifest.schemaVersion,
			payload: fixture.manifest.payload,
		}),
	)
	expect(() =>
		parseAndVerifyManifest(
			unsignedBytes,
			sha256(unsignedBytes),
			manifestKeyRegistry,
		),
	).toThrow('invalid versioned shape')

	const tampered = structuredClone(fixture.manifest)
	tampered.payload.sql.sha256 = 'f'.repeat(64)
	const tamperedBytes = new TextEncoder().encode(JSON.stringify(tampered))
	expect(() =>
		parseAndVerifyManifest(
			tamperedBytes,
			sha256(tamperedBytes),
			manifestKeyRegistry,
		),
	).toThrow('signature verification failed')

	const unknownKey = structuredClone(fixture.manifest)
	unknownKey.payload.signing.keyId = 'unknown-backup-key'
	unknownKey.signature.keyId = 'unknown-backup-key'
	unknownKey.signature.value = signManifestPayload(unknownKey.payload)
	const unknownKeyBytes = new TextEncoder().encode(JSON.stringify(unknownKey))
	expect(() =>
		parseAndVerifyManifest(
			unknownKeyBytes,
			sha256(unknownKeyBytes),
			manifestKeyRegistry,
		),
	).toThrow('signing key is not trusted')

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

test('isolation verification normalizes numeric SQLite user IDs', () => {
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

test('restore trust registry is exact, pins the reviewed identities, and cannot be replaced by operator assertions', async () => {
	expect(parseRestoreTrustRegistry(createTrustRegistry())).toEqual(
		createTrustRegistry(),
	)
	expect(() =>
		parseRestoreTrustRegistry({
			...createTrustRegistry(),
			operatorApproved: true,
		}),
	).toThrow('invalid shape')
	expect(() =>
		parseRestoreTrustRegistry({
			...createTrustRegistry(),
			productionSources: [
				{
					accountId: productionAccountId,
					databaseId: productionUuid,
					databaseName: 'kody-production',
					purpose: 'production',
				},
			],
		}),
	).toThrow('invalid shape')
	expect(() =>
		parseRestoreTrustRegistry(
			createTrustRegistry({
				drillTargets: [
					{ accountId: 'not-a-cloudflare-account', databaseName: 'kody-drill' },
				],
			}),
		),
	).toThrow('Cloudflare account ID')
	expect(() =>
		parseRestoreTrustRegistry(
			createTrustRegistry({
				productionSources: [
					{
						accountId: productionAccountId.toUpperCase(),
						databaseId: productionUuid,
						databaseName: 'kody-production',
					},
				],
			}),
		),
	).toThrow('Cloudflare account ID')
	expect(() =>
		parseRestoreTrustRegistry(
			createTrustRegistry({
				drillTargets: [
					{
						accountId: targetAccountId.toUpperCase(),
						databaseName: 'kody-drill',
					},
				],
			}),
		),
	).toThrow('Cloudflare account ID')

	const checkedRegistry = JSON.parse(
		await readFile(restoreTrustRegistryPath, 'utf8'),
	) as unknown
	const checkedManifestKeys = JSON.parse(
		await readFile(manifestPublicKeyRegistryPath, 'utf8'),
	) as unknown
	const checkedBaselines = JSON.parse(
		await readFile(restoreBaselineRegistryPath, 'utf8'),
	) as unknown
	expect(
		parseTrustedManifestPublicKeyRegistry(checkedManifestKeys).keys,
	).toEqual([
		{
			algorithm: 'Ed25519',
			keyId: 'kody-dr-2026-07',
			publicKeyPem:
				'-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA3jqjPcGTzWefE5PGyRBdUQKAEj7FFGtFIz+223sbt9A=\n-----END PUBLIC KEY-----\n',
		},
	])
	expect(
		parseTrustedRestoreBaselineRegistry(checkedBaselines, parseBaseline)
			.baselines,
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
		],
		drillTargets: [
			{
				accountId: 'a41d50ecaf0ae0f86dd1824ef6729cb2',
				databaseName: 'kody-dr-drill-manual',
			},
		],
	})
	await expect(
		runD1RestoreDrill(
			drillInput({ trustRegistry: checkedRegistry }),
			createAdapters(),
		),
	).rejects.toThrow('manifest source identity is not approved')
	const checkedRegistryAdapters = createAdapters()
	await expect(
		runD1RestoreDrill(
			drillInput({ trustRegistry: checkedRegistry, dryRun: false }),
			checkedRegistryAdapters,
		),
	).rejects.toThrow('manifest source identity is not approved')
	expect(checkedRegistryAdapters.createTarget).not.toHaveBeenCalled()

	const fabricated = manifestFixture({
		source: {
			accountId: targetAccountId,
			databaseId: targetUuid,
			databaseName: 'kody-drill',
		},
	})
	const fabricatedAdapters = createAdapters()
	await expect(
		runD1RestoreDrill(
			drillInput({
				manifestBytes: fabricated.bytes,
				expectedManifestSha256: fabricated.checksum,
				allowlist: [
					{
						accountId: targetAccountId,
						name: 'kody-drill',
						purpose: 'drill',
					},
				],
				dryRun: false,
			}),
			fabricatedAdapters,
		),
	).rejects.toThrow('manifest source identity is not approved')
	expect(fabricatedAdapters.createTarget).not.toHaveBeenCalled()

	expect(() =>
		parseArguments([
			'--manifest',
			'manifest.json',
			'--manifest-sha256',
			'0'.repeat(64),
			'--backup',
			'backup.sql',
			'--baseline-id',
			'production-baseline-2026',
			'--allowlist',
			'operator-registry.json',
			'--target-account-id',
			targetAccountId,
			'--target-name',
			'kody-drill',
		]),
	).toThrow('Unknown argument: --allowlist')
})

test('restore trust matches runtime account IDs case-insensitively', async () => {
	const source = createManifest().payload.source
	const fixture = manifestFixture({
		source: {
			...source,
			accountId: productionAccountId.toUpperCase(),
		},
	})
	await expect(
		runD1RestoreDrill(
			drillInput({
				manifestBytes: fixture.bytes,
				expectedManifestSha256: fixture.checksum,
				targetAccountId: targetAccountId.toUpperCase(),
			}),
			createAdapters(),
		),
	).resolves.toMatchObject({ dryRun: true })
})
