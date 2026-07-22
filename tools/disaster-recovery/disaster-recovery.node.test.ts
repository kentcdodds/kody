import { expect, test, vi } from 'vitest'
import {
	type BackupManifest,
	type D1TargetEvidence,
	type DrillAdapters,
	type QueryRow,
	type RestoreBaseline,
	type VerificationQuery,
	buildDrillCommands,
	buildVerificationQueries,
	parseAndVerifyManifest,
	runD1RestoreDrill,
} from './d1-restore-drill.ts'
import {
	type ResourceEvidence,
	assessCanonicalReadiness,
	canonicalContracts,
} from './canonical-readiness.ts'
import { canonicalJson, sha256 } from './canonical-json.ts'

const productionUuid = '11111111-1111-4111-8111-111111111111'
const targetUuid = '22222222-2222-4222-8222-222222222222'
const backupBytes = new TextEncoder().encode('backup')
const schemaRows: Array<Record<string, string>> = []

function createManifest(
	overrides: Partial<BackupManifest> = {},
): BackupManifest {
	return {
		schemaVersion: 1,
		source: {
			accountId: 'account-id',
			accountName: 'production-account',
			databaseId: productionUuid,
			databaseName: 'kody-production',
		},
		bookmark: 'bookmark-1',
		scheduledAt: '2026-07-20T00:00:00.000Z',
		startedAt: '2026-07-20T00:01:00.000Z',
		completedAt: '2026-07-20T00:02:00.000Z',
		objectKey: `daily/${productionUuid}/2026-07-20/backup.sql`,
		bytes: backupBytes.byteLength,
		sha256: sha256(backupBytes),
		r2Etag: 'etag-1',
		commit: 'abc123',
		retentionTier: 'daily',
		...overrides,
	}
}

function manifestFixture(overrides: Partial<BackupManifest> = {}): {
	manifest: BackupManifest
	bytes: Uint8Array
	checksum: string
} {
	const manifest = createManifest(overrides)
	const bytes = new TextEncoder().encode(JSON.stringify(manifest))
	return { manifest, bytes, checksum: sha256(bytes) }
}

function createBaseline(
	overrides: Partial<RestoreBaseline> = {},
): RestoreBaseline {
	return {
		schemaVersion: 1,
		sourceDatabaseId: productionUuid,
		migrationNames: ['0001-initial.sql'],
		schemaSha256: sha256(canonicalJson(schemaRows)),
		sequenceTables: ['messages'],
		isolationChecks: [
			{
				table: 'messages',
				userColumn: 'user_id',
				primaryKeyColumn: 'id',
				users: [
					{
						userId: 'user-a',
						rowCount: 1,
						primaryKeySha256: sha256(canonicalJson(['message-a'])),
					},
					{
						userId: 'user-b',
						rowCount: 1,
						primaryKeySha256: sha256(canonicalJson(['message-b'])),
					},
				],
			},
		],
		...overrides,
	}
}

function createTarget(
	uuid = targetUuid,
	name = 'kody-drill',
): D1TargetEvidence {
	return {
		uuid,
		name,
		createdAt: '2026-07-21T00:00:00.000Z',
		bindings: [],
		isEmpty: true,
	}
}

function queryRows(query: VerificationQuery): Array<QueryRow> {
	switch (query.id) {
		case 'integrity':
			return [{ integrity_check: 'ok' }]
		case 'foreign-keys':
			return []
		case 'migrations':
			return [{ name: '0001-initial.sql' }]
		case 'schema':
			return schemaRows
		case 'sequences':
			return [{ table_name: 'messages', sequence_value: 2, max_rowid: 2 }]
		case 'isolation':
			return [
				{
					table_name: 'messages',
					user_id: 'user-a',
					primary_key: 'message-a',
				},
				{
					table_name: 'messages',
					user_id: 'user-b',
					primary_key: 'message-b',
				},
			]
		default: {
			const exhaustive: never = query.id
			throw new Error(String(exhaustive))
		}
	}
}

function createAdapters(): DrillAdapters {
	return {
		run: vi.fn(async () => undefined),
		query: vi.fn(async (_targetUuid: string, query: VerificationQuery) =>
			queryRows(query),
		),
	}
}

function drillInput(overrides: Record<string, unknown> = {}) {
	const fixture = manifestFixture()
	return {
		manifestBytes: fixture.bytes,
		expectedManifestSha256: fixture.checksum,
		backupBytes,
		backupFile: '/operator/downloads/backup.sql',
		baseline: createBaseline(),
		target: createTarget(),
		allowlist: [
			{ uuid: targetUuid, name: 'kody-drill', purpose: 'drill' as const },
		],
		...overrides,
	}
}

test('D1 drill verifies exact manifest bytes, actual manifest shape, SQL checksum, and size limit', async () => {
	const fixture = manifestFixture()
	expect(parseAndVerifyManifest(fixture.bytes, fixture.checksum)).toEqual(
		fixture.manifest,
	)
	await expect(
		runD1RestoreDrill(
			drillInput({ expectedManifestSha256: '0'.repeat(64) }),
			createAdapters(),
		),
	).rejects.toThrow('manifest bytes do not match')

	const extraFieldBytes = new TextEncoder().encode(
		JSON.stringify({ ...fixture.manifest, unexpected: true }),
	)
	await expect(
		runD1RestoreDrill(
			drillInput({
				manifestBytes: extraFieldBytes,
				expectedManifestSha256: sha256(extraFieldBytes),
			}),
			createAdapters(),
		),
	).rejects.toThrow('invalid shape')

	await expect(
		runD1RestoreDrill(
			drillInput({
				backupBytes: new TextEncoder().encode('corrup'),
				dryRun: false,
			}),
			createAdapters(),
		),
	).rejects.toThrow('local SQL bytes or checksum')

	const oversized = manifestFixture({
		bytes: 5 * 1024 * 1024 * 1024 + 1,
	})
	await expect(
		runD1RestoreDrill(
			drillInput({
				manifestBytes: oversized.bytes,
				expectedManifestSha256: oversized.checksum,
			}),
			createAdapters(),
		),
	).rejects.toThrow('exceeds the 5 GiB')
})

test('D1 drill rejects production targets, bound/nonempty/stale targets, and mismatched baseline or allowlist', async () => {
	const adapters = createAdapters()
	await expect(
		runD1RestoreDrill(
			drillInput({ target: createTarget(productionUuid, 'other') }),
			adapters,
		),
	).rejects.toThrow('production database UUID')
	await expect(
		runD1RestoreDrill(
			drillInput({ target: createTarget(targetUuid, 'kody-production') }),
			adapters,
		),
	).rejects.toThrow('production database name')
	await expect(
		runD1RestoreDrill(
			drillInput({
				target: { ...createTarget(), bindings: ['worker/APP_DB'] },
			}),
			adapters,
		),
	).rejects.toThrow('unbound')
	await expect(
		runD1RestoreDrill(
			drillInput({ target: { ...createTarget(), isEmpty: false } }),
			adapters,
		),
	).rejects.toThrow('must be empty')
	await expect(
		runD1RestoreDrill(
			drillInput({
				target: {
					...createTarget(),
					createdAt: '2026-07-19T00:00:00.000Z',
				},
			}),
			adapters,
		),
	).rejects.toThrow('not fresh')
	await expect(
		runD1RestoreDrill(drillInput({ allowlist: [] }), adapters),
	).rejects.toThrow('allowlisted as a drill')
	await expect(
		runD1RestoreDrill(
			drillInput({
				baseline: createBaseline({
					sourceDatabaseId: '33333333-3333-4333-8333-333333333333',
				}),
			}),
			adapters,
		),
	).rejects.toThrow('baseline source database does not match')
	expect(adapters.run).not.toHaveBeenCalled()
})

test('D1 plan and execution import, verify baseline, migrate, then optionally verify post-forward', async () => {
	const baseline = createBaseline()
	const postForwardBaseline = createBaseline()
	const queries = buildVerificationQueries(baseline, 'baseline')
	expect(queries.find((query) => query.id === 'isolation')?.sql).toContain(
		"\"user_id\" IN ('user-a','user-b')",
	)
	const commands = buildDrillCommands({
		backupFile: '/operator/downloads/backup.sql',
		targetUuid,
		baseline,
		applyForwardMigrations: true,
		postForwardBaseline,
	})
	expect(
		commands.map((command) =>
			command.kind === 'verification'
				? `${command.phase}-verification`
				: command.kind,
		),
	).toEqual([
		'import',
		...Array<string>(6).fill('baseline-verification'),
		'migration',
		...Array<string>(6).fill('post-forward-verification'),
	])

	const dryAdapters = createAdapters()
	const dryRun = await runD1RestoreDrill(drillInput(), dryAdapters)
	expect(dryRun.dryRun).toBe(true)
	expect(dryAdapters.run).not.toHaveBeenCalled()
	expect(dryAdapters.query).not.toHaveBeenCalled()

	const events: Array<string> = []
	const adapters: DrillAdapters = {
		async run(command) {
			events.push(command.kind)
		},
		async query(_uuid, query) {
			events.push(`${query.phase}:${query.id}`)
			return queryRows(query)
		},
	}
	await runD1RestoreDrill(
		drillInput({
			applyForwardMigrations: true,
			postForwardBaseline,
			dryRun: false,
		}),
		adapters,
	)
	expect(events).toEqual([
		'import',
		'baseline:integrity',
		'baseline:foreign-keys',
		'baseline:migrations',
		'baseline:schema',
		'baseline:sequences',
		'baseline:isolation',
		'migration',
		'post-forward:integrity',
		'post-forward:foreign-keys',
		'post-forward:migrations',
		'post-forward:schema',
		'post-forward:sequences',
		'post-forward:isolation',
	])
})

function completeEvidence(): Array<ResourceEvidence> {
	return canonicalContracts.map((contract) => ({
		id: contract.id,
		supported: true,
		inventoryComplete: true,
		sourceCredential: true,
		destinationCredential: true,
		contractRepresented: true,
		evidence: [`verified:${contract.id}`],
	}))
}

test('canonical contracts represent exact canonical and full-service rebuild boundaries', () => {
	const storage = canonicalContracts.find(
		(contract) => contract.id === 'STORAGE_RUNNER',
	)
	expect(storage?.includes).toEqual(
		expect.arrayContaining([
			'per known instance KV keys, values, metadata, and expiration',
			'per known instance SQLite schema and row data',
			'round-trip verification for both KV and SQLite representations',
		]),
	)
	expect(storage?.excludes).toContain(
		'claim that generic SQL enumerates unknown Durable Object instances',
	)
	const secret = canonicalContracts.find(
		(contract) => contract.id === 'SECRET_STORE_KEY',
	)
	expect(secret).toMatchObject({
		requiredFor: 'canonical-data',
		transfer: 'secret-fingerprint-escrow',
		includes: expect.arrayContaining([
			'external escrow custody and recovery-test evidence',
		]),
	})
	expect(
		canonicalContracts
			.filter((contract) => contract.requiredFor === 'full-service')
			.map((contract) => contract.id),
	).toEqual(
		expect.arrayContaining([
			'VECTORIZE',
			'BUNDLE_ARTIFACTS_KV',
			'COMMUNITY_ICONS',
			'ALARMS',
			'QUEUES_WORKFLOWS',
			'OAUTH',
		]),
	)
})

test('readiness fails canonical secret coverage and every missing full-service rebuild resource', () => {
	const withoutSecret = completeEvidence().filter(
		(item) => item.id !== 'SECRET_STORE_KEY',
	)
	const canonical = assessCanonicalReadiness(withoutSecret)
	expect(canonical.levels['d1-only'].ready).toBe(true)
	expect(canonical.levels['canonical-data'].ready).toBe(false)
	expect(canonical.levels['canonical-data'].failures).toContain(
		'SECRET_STORE_KEY: missing inventory evidence',
	)

	const fullServiceIds = canonicalContracts
		.filter((contract) => contract.requiredFor === 'full-service')
		.map((contract) => contract.id)
	for (const id of fullServiceIds) {
		const result = assessCanonicalReadiness(
			completeEvidence().filter((item) => item.id !== id),
		)
		expect(result.levels['canonical-data'].ready).toBe(true)
		expect(result.levels['full-service'].ready).toBe(false)
		expect(result.levels['full-service'].failures).toContain(
			`${id}: missing inventory evidence`,
		)
	}

	const broken = completeEvidence()
	const vectorize = broken.find((item) => item.id === 'VECTORIZE')
	if (!vectorize) throw new Error('fixture lacks VECTORIZE')
	vectorize.supported = false
	const queues = broken.find((item) => item.id === 'QUEUES_WORKFLOWS')
	if (!queues) throw new Error('fixture lacks QUEUES_WORKFLOWS')
	queues.destinationCredential = false
	const result = assessCanonicalReadiness(broken)
	expect(result.levels['full-service'].failures).toEqual(
		expect.arrayContaining([
			'VECTORIZE: transfer unsupported',
			'QUEUES_WORKFLOWS: destination credential is missing',
		]),
	)
	expect(
		assessCanonicalReadiness(completeEvidence()).levels['full-service'],
	).toEqual({ ready: true, failures: [] })
})
