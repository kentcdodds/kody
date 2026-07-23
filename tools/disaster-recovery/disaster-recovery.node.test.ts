import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, test, vi } from 'vitest'
import {
	type BackupManifest,
	type DrillAdapters,
	type QueryRow,
	type RestoreBaseline,
	type RestoreTrustRegistry,
	type VerificationQuery,
	buildDrillCommands,
	buildVerificationQueries,
	parseAndVerifyManifest,
	parseRestoreTrustRegistry,
	runD1RestoreDrill,
	verifyRows,
} from './d1-restore-drill.ts'
import {
	buildD1RestoreWranglerConfig,
	collectBackupFileEvidence,
	createD1DrillTarget,
	parseArguments,
	parseQueryRows,
	restoreTrustRegistryPath,
	runProcess,
} from './d1-restore-drill-cli.ts'
import { canonicalJson, sha256 } from './canonical-json.ts'

const productionUuid = '11111111-1111-4111-8111-111111111111'
const targetUuid = '22222222-2222-4222-8222-222222222222'
const productionAccountId = 'a'.repeat(32)
const targetAccountId = 'b'.repeat(32)
const backupBytes = new TextEncoder().encode('backup')
const schemaRows: Array<Record<string, string>> = []
const now = new Date('2026-07-22T12:00:00.000Z')

function createManifest(
	overrides: Partial<BackupManifest> = {},
): BackupManifest {
	return {
		schemaVersion: 1,
		source: {
			accountId: productionAccountId,
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

function manifestFixture(overrides: Partial<BackupManifest> = {}) {
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

function createTrustRegistry(
	overrides: Partial<RestoreTrustRegistry> = {},
): RestoreTrustRegistry {
	return {
		schemaVersion: 1,
		productionSources: [
			{
				accountId: productionAccountId,
				databaseId: productionUuid,
				databaseName: 'kody-production',
			},
		],
		drillTargets: [
			{
				accountId: targetAccountId,
				databaseName: 'kody-drill',
			},
		],
		...overrides,
	}
}

function queryRows(query: VerificationQuery): Array<QueryRow> {
	switch (query.id) {
		case 'integrity':
			return [{ quick_check: 'ok' }]
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
		createTarget: vi.fn(async () => ({
			uuid: targetUuid,
			name: 'kody-drill',
			createdAt: now.toISOString(),
		})),
		now: vi.fn(() => now),
		writeTemporaryConfig: vi.fn(async () => ({
			path: '/tmp/kody-d1-restore/wrangler.json',
			cleanup: vi.fn(async () => undefined),
		})),
		run: vi.fn(async () => undefined),
		query: vi.fn(async (_command, query: VerificationQuery) =>
			queryRows(query),
		),
	}
}

function drillInput(overrides: Record<string, unknown> = {}) {
	const fixture = manifestFixture()
	return {
		manifestBytes: fixture.bytes,
		expectedManifestSha256: fixture.checksum,
		backupFileEvidence: {
			sizeBytes: backupBytes.byteLength,
			sha256: sha256(backupBytes),
		},
		backupFile: '/operator/downloads/backup.sql',
		baseline: createBaseline(),
		targetAccountId,
		targetName: 'kody-drill',
		trustRegistry: createTrustRegistry(),
		...overrides,
	}
}

test('D1 drill verifies immutable manifest and supplied SQL file evidence before any live creation', async () => {
	const fixture = manifestFixture()
	expect(parseAndVerifyManifest(fixture.bytes, fixture.checksum)).toEqual(
		fixture.manifest,
	)
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

test('restore trust registry is exact, checked-in empty, and cannot be replaced by operator assertions', async () => {
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
	expect(parseRestoreTrustRegistry(checkedRegistry)).toEqual({
		schemaVersion: 1,
		productionSources: [],
		drillTargets: [],
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
			accountName: 'operator-claimed-production',
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
				baseline: createBaseline({ sourceDatabaseId: targetUuid }),
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
			'--baseline',
			'baseline.json',
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
	const source = createManifest().source
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

test('relative disaster-recovery CLI entry paths execute main', async () => {
	const environment = {
		HOME: process.env.HOME,
		PATH: process.env.PATH,
		TMPDIR: process.env.TMPDIR,
	}
	await expect(
		runProcess(
			{
				kind: 'verification',
				program: process.execPath,
				args: ['tools/disaster-recovery/d1-restore-drill-cli.ts'],
			},
			environment,
			false,
		),
	).rejects.toThrow('Missing required argument --manifest')
	await expect(
		runProcess(
			{
				kind: 'verification',
				program: process.execPath,
				args: ['tools/disaster-recovery/canonical-readiness-cli.ts'],
			},
			environment,
			false,
		),
	).rejects.toThrow('Usage: canonical-readiness-cli.ts')
})

test('SQL file evidence streams injected chunks after stat and rejects sizes without reading the dump', async () => {
	const events: Array<string> = []
	const evidence = await collectBackupFileEvidence('backup.sql', 6, {
		async statFile(file) {
			events.push(`stat:${file}`)
			return { size: 6 }
		},
		readChunks(file) {
			events.push(`stream:${file}`)
			return (async function* () {
				yield new TextEncoder().encode('back')
				yield new TextEncoder().encode('up')
			})()
		},
	})
	expect(evidence).toEqual({
		sizeBytes: 6,
		sha256: sha256(backupBytes),
	})
	expect(events).toEqual(['stat:backup.sql', 'stream:backup.sql'])
	await expect(
		runD1RestoreDrill(
			drillInput({ backupFileEvidence: evidence }),
			createAdapters(),
		),
	).resolves.toMatchObject({ dryRun: true })

	const readChunks = vi.fn((): AsyncIterable<Uint8Array> => {
		throw new Error('dump stream must not be opened')
	})
	await expect(
		collectBackupFileEvidence('backup.sql', 7, {
			async statFile() {
				return { size: 6 }
			},
			readChunks,
		}),
	).rejects.toThrow('size does not match the manifest')
	await expect(
		collectBackupFileEvidence('backup.sql', 5 * 1024 * 1024 * 1024, {
			async statFile() {
				return { size: 5 * 1024 * 1024 * 1024 }
			},
			readChunks,
		}),
	).rejects.toThrow('exceeds the 5 GiB')
	expect(readChunks).not.toHaveBeenCalled()
})

test('dry-run is non-mutating and live execution creates in a distinct approved account immediately before import', async () => {
	const dryAdapters = createAdapters()
	const dryRun = await runD1RestoreDrill(drillInput(), dryAdapters)
	expect(dryRun.dryRun).toBe(true)
	expect(dryRun.commands[0]).toMatchObject({
		kind: 'provision',
		program: 'cloudflare-api',
	})
	expect(dryRun.commands[1]?.args).toEqual([
		'd1',
		'execute',
		'D1_RESTORE_TARGET',
		'--remote',
		'--config',
		'<temporary-wrangler-config>',
		'--file',
		'/operator/downloads/backup.sql',
	])
	expect(dryAdapters.createTarget).not.toHaveBeenCalled()
	expect(dryAdapters.writeTemporaryConfig).not.toHaveBeenCalled()
	expect(dryAdapters.run).not.toHaveBeenCalled()

	const events: Array<string> = []
	const liveAdapters: DrillAdapters = {
		async createTarget(input) {
			events.push(`create:${input.accountId}:${input.name}`)
			return {
				uuid: targetUuid,
				name: input.name,
				createdAt: now.toISOString(),
			}
		},
		now() {
			return now
		},
		async writeTemporaryConfig(input) {
			events.push(`config:${input.targetName}:${input.targetUuid}`)
			return {
				path: '/tmp/live-restore/wrangler.json',
				async cleanup() {
					events.push('cleanup-config')
				},
			}
		},
		async run(command) {
			events.push(command.kind)
			expect(command.args).toContain('D1_RESTORE_TARGET')
			expect(command.args).toContain('/tmp/live-restore/wrangler.json')
		},
		async query(command, query) {
			expect(command.args).toContain('D1_RESTORE_TARGET')
			expect(command.args).toContain('/tmp/live-restore/wrangler.json')
			events.push(`${query.phase}:${query.id}`)
			return queryRows(query)
		},
	}
	await runD1RestoreDrill(drillInput({ dryRun: false }), liveAdapters)
	expect(events).toEqual([
		`create:${targetAccountId}:kody-drill`,
		`config:kody-drill:${targetUuid}`,
		'import',
		'baseline:integrity',
		'baseline:foreign-keys',
		'baseline:migrations',
		'baseline:schema',
		'baseline:sequences',
		'baseline:isolation',
		'cleanup-config',
	])
})

test('target account, returned creation evidence, and forward baseline fail closed', async () => {
	await expect(
		runD1RestoreDrill(
			drillInput({ targetAccountId: productionAccountId }),
			createAdapters(),
		),
	).rejects.toThrow('target account must differ')
	await expect(
		runD1RestoreDrill(
			drillInput({
				trustRegistry: createTrustRegistry({ drillTargets: [] }),
				dryRun: false,
			}),
			createAdapters(),
		),
	).rejects.toThrow('target account/name is not approved')
	const staleAdapters = createAdapters()
	staleAdapters.createTarget = vi.fn(async () => ({
		uuid: targetUuid,
		name: 'kody-drill',
		createdAt: '2026-07-20T00:00:00.000Z',
	}))
	await expect(
		runD1RestoreDrill(drillInput({ dryRun: false }), staleAdapters),
	).rejects.toThrow('outside creation window')
	expect(staleAdapters.run).not.toHaveBeenCalled()
	const productionIdAdapters = createAdapters()
	productionIdAdapters.createTarget = vi.fn(async () => ({
		uuid: productionUuid,
		name: 'kody-drill',
		createdAt: now.toISOString(),
	}))
	await expect(
		runD1RestoreDrill(drillInput({ dryRun: false }), productionIdAdapters),
	).rejects.toThrow('production database UUID')
	expect(productionIdAdapters.run).not.toHaveBeenCalled()

	await expect(
		runD1RestoreDrill(
			drillInput({ applyForwardMigrations: true }),
			createAdapters(),
		),
	).rejects.toThrow('require a post-forward baseline')
	const baseline = createBaseline()
	const commands = buildDrillCommands({
		backupFile: '/operator/downloads/backup.sql',
		targetAccountId,
		targetName: 'kody-drill',
		configPath: '/tmp/restore/wrangler.json',
		baseline,
		applyForwardMigrations: true,
		postForwardBaseline: baseline,
	})
	expect(
		commands.map((command) =>
			command.kind === 'verification'
				? `${command.phase}-verification`
				: command.kind,
		),
	).toEqual([
		'provision',
		'import',
		...Array<string>(6).fill('baseline-verification'),
		'migration',
		...Array<string>(6).fill('post-forward-verification'),
	])
	expect(buildVerificationQueries(baseline, 'baseline')).toHaveLength(6)
})

test('temporary D1 config and live forward migration commands target the configured binding exactly', async () => {
	const configPath = '/tmp/kody-d1-restore-abc/wrangler.json'
	expect(
		buildD1RestoreWranglerConfig({
			configPath,
			migrationsDirectory: '/workspace/packages/worker/migrations',
			targetName: 'kody-drill',
			targetUuid,
		}),
	).toEqual({
		d1_databases: [
			{
				binding: 'D1_RESTORE_TARGET',
				database_name: 'kody-drill',
				database_id: targetUuid,
				migrations_dir: '../../workspace/packages/worker/migrations',
			},
		],
	})

	const executedCommands: Array<{
		kind: string
		phase?: string
		args: Array<string>
	}> = []
	const adapters: DrillAdapters = {
		async createTarget(input) {
			return {
				uuid: targetUuid,
				name: input.name,
				createdAt: now.toISOString(),
			}
		},
		now() {
			return now
		},
		async writeTemporaryConfig(input) {
			expect(input).toEqual({ targetName: 'kody-drill', targetUuid })
			return { path: configPath, cleanup: vi.fn(async () => undefined) }
		},
		async run(command) {
			executedCommands.push(command)
		},
		async query(command, query) {
			executedCommands.push(command)
			return queryRows(query)
		},
	}
	const baseline = createBaseline()
	await runD1RestoreDrill(
		drillInput({
			dryRun: false,
			applyForwardMigrations: true,
			postForwardBaseline: baseline,
		}),
		adapters,
	)
	const expectedPlan = buildDrillCommands({
		backupFile: '/operator/downloads/backup.sql',
		targetAccountId,
		targetName: 'kody-drill',
		configPath,
		baseline,
		applyForwardMigrations: true,
		postForwardBaseline: baseline,
	})
	expect(executedCommands).toEqual(expectedPlan.slice(1))
	expect(executedCommands[0]?.args).toEqual([
		'd1',
		'execute',
		'D1_RESTORE_TARGET',
		'--remote',
		'--config',
		configPath,
		'--file',
		'/operator/downloads/backup.sql',
	])
	expect(executedCommands[1]?.args).toEqual([
		'd1',
		'execute',
		'D1_RESTORE_TARGET',
		'--remote',
		'--config',
		configPath,
		'--json',
		'--command',
		'PRAGMA quick_check',
	])
	expect(executedCommands[2]?.args.at(-1)).toBe('PRAGMA foreign_key_check')
	expect(executedCommands[7]?.args).toEqual([
		'd1',
		'migrations',
		'apply',
		'D1_RESTORE_TARGET',
		'--remote',
		'--config',
		configPath,
	])
	for (const command of executedCommands) {
		expect(command.args).not.toContain(targetUuid)
		expect(command.args).toContain(configPath)
	}
})

test('real local Wrangler returns quick_check rows through the production parser', async () => {
	const directory = await mkdtemp(
		path.join(os.tmpdir(), 'd1-restore-contract-'),
	)
	try {
		const configPath = path.join(directory, 'wrangler.json')
		const migrationsDirectory = path.join(directory, 'migrations')
		const persistDirectory = path.join(directory, 'state')
		await mkdir(migrationsDirectory)
		await writeFile(
			path.join(migrationsDirectory, '0001-contract-check.sql'),
			'CREATE TABLE contract_check (id INTEGER PRIMARY KEY);\n',
		)
		await writeFile(
			configPath,
			JSON.stringify(
				buildD1RestoreWranglerConfig({
					configPath,
					migrationsDirectory,
					targetName: 'restore-contract',
					targetUuid,
				}),
			),
		)
		const cleanEnvironment = {
			HOME: process.env.HOME,
			PATH: process.env.PATH,
			TMPDIR: process.env.TMPDIR,
		}
		await runProcess(
			{
				kind: 'migration',
				program: 'wrangler',
				args: [
					'd1',
					'migrations',
					'apply',
					'D1_RESTORE_TARGET',
					'--local',
					'--config',
					configPath,
					'--persist-to',
					persistDirectory,
				],
			},
			cleanEnvironment,
			false,
		)
		const query = buildVerificationQueries(createBaseline(), 'baseline')[0]
		if (!query) throw new Error('fixture lacks quick_check query')
		const output = await runProcess(
			{
				kind: 'verification',
				phase: query.phase,
				program: 'wrangler',
				args: [
					'd1',
					'execute',
					'D1_RESTORE_TARGET',
					'--local',
					'--config',
					configPath,
					'--persist-to',
					persistDirectory,
					'--json',
					'--command',
					query.sql,
				],
			},
			cleanEnvironment,
			false,
		)
		const rows = parseQueryRows(output)
		expect(rows).toEqual([{ quick_check: 'ok' }])
		expect(() => verifyRows(query, rows, createBaseline())).not.toThrow()
		expect(() =>
			verifyRows(query, [{ integrity_check: 'ok' }], createBaseline()),
		).toThrow('PRAGMA quick_check failed')
		expect(() =>
			verifyRows(query, [{ QUICK_CHECK: 'OK' }], createBaseline()),
		).not.toThrow()
	} finally {
		await rm(directory, { recursive: true, force: true })
	}
}, 30_000)

test('Cloudflare create adapter uses documented endpoint and validates response envelope', async () => {
	const fetcher = vi.fn(async () => {
		return new Response(
			JSON.stringify({
				success: true,
				result: {
					uuid: targetUuid,
					name: 'kody-drill',
					created_at: now.toISOString(),
				},
			}),
			{ status: 200, headers: { 'Content-Type': 'application/json' } },
		)
	})
	await expect(
		createD1DrillTarget({
			accountId: targetAccountId,
			name: 'kody-drill',
			token: 'drill-only-token',
			fetcher,
			apiBaseUrl: 'https://api.example.test/client/v4',
		}),
	).resolves.toEqual({
		uuid: targetUuid,
		name: 'kody-drill',
		createdAt: now.toISOString(),
	})
	expect(fetcher).toHaveBeenCalledWith(
		`https://api.example.test/client/v4/accounts/${targetAccountId}/d1/database`,
		expect.objectContaining({
			method: 'POST',
			body: JSON.stringify({ name: 'kody-drill' }),
		}),
	)
})
