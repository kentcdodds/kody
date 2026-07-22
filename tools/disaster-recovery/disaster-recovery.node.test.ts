import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test, vi } from 'vitest'
import {
	type BackupManifest,
	type DrillAdapters,
	type QueryRow,
	type RestoreBaseline,
	type VerificationQuery,
	buildDrillCommands,
	buildVerificationQueries,
	parseAndVerifyManifest,
	runD1RestoreDrill,
} from './d1-restore-drill.ts'
import { createD1DrillTarget } from './d1-restore-drill-cli.ts'
import { verifyLocalArtifactFiles } from './canonical-readiness-cli.ts'
import {
	type EvidenceArtifact,
	type ResourceEvidence,
	assessCanonicalReadiness,
	canonicalContracts,
	maximumEvidenceAgeDays,
} from './canonical-readiness.ts'
import { canonicalJson, sha256 } from './canonical-json.ts'

const productionUuid = '11111111-1111-4111-8111-111111111111'
const targetUuid = '22222222-2222-4222-8222-222222222222'
const backupBytes = new TextEncoder().encode('backup')
const schemaRows: Array<Record<string, string>> = []
const now = new Date('2026-07-22T12:00:00.000Z')

function createManifest(
	overrides: Partial<BackupManifest> = {},
): BackupManifest {
	return {
		schemaVersion: 1,
		source: {
			accountId: 'production-account-id',
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
		createTarget: vi.fn(async () => ({
			uuid: targetUuid,
			name: 'kody-drill',
			createdAt: now.toISOString(),
		})),
		now: vi.fn(() => now),
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
		targetAccountId: 'isolated-drill-account-id',
		targetName: 'kody-drill',
		allowlist: [
			{
				accountId: 'isolated-drill-account-id',
				name: 'kody-drill',
				purpose: 'drill' as const,
			},
		],
		...overrides,
	}
}

test('D1 drill verifies immutable manifest and SQL bytes before any live creation', async () => {
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
				backupBytes: new TextEncoder().encode('corrup'),
				dryRun: false,
			}),
			adapters,
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
				dryRun: false,
			}),
			adapters,
		),
	).rejects.toThrow('exceeds the 5 GiB')
	expect(adapters.createTarget).not.toHaveBeenCalled()
})

test('dry-run is non-mutating and live execution creates in a distinct allowlisted account immediately before import', async () => {
	const dryAdapters = createAdapters()
	const dryRun = await runD1RestoreDrill(drillInput(), dryAdapters)
	expect(dryRun.dryRun).toBe(true)
	expect(dryRun.commands[0]).toMatchObject({
		kind: 'provision',
		program: 'cloudflare-api',
	})
	expect(dryRun.commands[1]?.args).toContain('<live-created-d1-uuid>')
	expect(dryAdapters.createTarget).not.toHaveBeenCalled()
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
		async run(command) {
			events.push(command.kind)
			expect(command.args).toContain(targetUuid)
		},
		async query(uuid, query) {
			expect(uuid).toBe(targetUuid)
			events.push(`${query.phase}:${query.id}`)
			return queryRows(query)
		},
	}
	await runD1RestoreDrill(drillInput({ dryRun: false }), liveAdapters)
	expect(events).toEqual([
		'create:isolated-drill-account-id:kody-drill',
		'import',
		'baseline:integrity',
		'baseline:foreign-keys',
		'baseline:migrations',
		'baseline:schema',
		'baseline:sequences',
		'baseline:isolation',
	])
})

test('target account, returned creation evidence, and forward baseline fail closed', async () => {
	await expect(
		runD1RestoreDrill(
			drillInput({ targetAccountId: 'production-account-id' }),
			createAdapters(),
		),
	).rejects.toThrow('target account must differ')
	await expect(
		runD1RestoreDrill(
			drillInput({ allowlist: [], dryRun: false }),
			createAdapters(),
		),
	).rejects.toThrow('allowlisted as a drill')
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
		targetAccountId: 'isolated-drill-account-id',
		targetName: 'kody-drill',
		targetUuid,
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
			accountId: 'isolated-drill-account-id',
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
		'https://api.example.test/client/v4/accounts/isolated-drill-account-id/d1/database',
		expect.objectContaining({
			method: 'POST',
			body: JSON.stringify({ name: 'kody-drill' }),
		}),
	)
})

function artifact(resourceId: string, kind: EvidenceArtifact['kind']) {
	return {
		kind,
		type: 'application/json',
		uri: `artifacts/${resourceId}/${kind}.json`,
		sha256: 'a'.repeat(64),
	} satisfies EvidenceArtifact
}

function completeEvidence(): Array<ResourceEvidence> {
	return canonicalContracts.map((contract) => ({
		resourceId: contract.id,
		verifierIdentity: 'recovery-verifier@example.test',
		changeId: `CHG-${contract.id}`,
		performedAt: '2026-07-22T10:00:00.000Z',
		expiresAt: '2026-08-22T10:00:00.000Z',
		artifacts: contract.requiredEvidenceKinds.map((kind) =>
			artifact(contract.id, kind),
		),
	}))
}

function verifiedMap(
	evidence: ReadonlyArray<ResourceEvidence>,
): ReadonlyMap<string, string> {
	return new Map(
		evidence.flatMap((record) =>
			record.artifacts.map((item) => [item.uri, item.sha256] as const),
		),
	)
}

test('strict dated resource-specific evidence is required for readiness', () => {
	const complete = completeEvidence()
	const valid = assessCanonicalReadiness(complete, now, verifiedMap(complete))
	expect(valid.inputFailures).toEqual([])
	expect(valid.levels['full-service']).toEqual({ ready: true, failures: [] })

	const withoutFingerprint = completeEvidence()
	const secret = withoutFingerprint.find(
		(item) => item.resourceId === 'SECRET_STORE_KEY',
	)
	if (!secret) throw new Error('fixture lacks SECRET_STORE_KEY')
	secret.artifacts = secret.artifacts.filter(
		(item) => item.kind !== 'key-fingerprint',
	)
	const secretResult = assessCanonicalReadiness(
		withoutFingerprint,
		now,
		verifiedMap(withoutFingerprint),
	)
	expect(secretResult.levels['canonical-data'].ready).toBe(false)
	expect(secretResult.levels['canonical-data'].failures).toContain(
		'SECRET_STORE_KEY: missing key-fingerprint artifact',
	)

	for (const contract of canonicalContracts.filter(
		(item) => item.requiredFor === 'full-service',
	)) {
		const evidence = completeEvidence()
		const record = evidence.find((item) => item.resourceId === contract.id)
		if (!record) throw new Error(`fixture lacks ${contract.id}`)
		const specificKind = contract.requiredEvidenceKinds.at(-1)
		record.artifacts = record.artifacts.filter(
			(item) => item.kind !== specificKind,
		)
		expect(
			assessCanonicalReadiness(evidence, now, verifiedMap(evidence)).levels[
				'full-service'
			].ready,
		).toBe(false)
	}
})

test('readiness requires independently verified local artifact bytes', async () => {
	const evidence = completeEvidence()
	expect(assessCanonicalReadiness(evidence, now).levels['d1-only'].ready).toBe(
		false,
	)
	const missing = new Map(verifiedMap(evidence))
	const firstArtifact = evidence[0]?.artifacts[0]
	if (!firstArtifact) throw new Error('fixture lacks artifacts')
	missing.delete(firstArtifact.uri)
	expect(
		assessCanonicalReadiness(evidence, now, missing).levels['d1-only'].failures,
	).toContain(
		`APP_DB: artifact bytes were not locally verified: ${firstArtifact.uri}`,
	)
	const mismatch = new Map(verifiedMap(evidence))
	mismatch.set(firstArtifact.uri, 'b'.repeat(64))
	expect(
		assessCanonicalReadiness(evidence, now, mismatch).levels['d1-only']
			.failures,
	).toContain(
		`APP_DB: locally verified artifact digest mismatch: ${firstArtifact.uri}`,
	)

	const directory = await mkdtemp(path.join(os.tmpdir(), 'readiness-artifact-'))
	try {
		const artifactPath = path.join(directory, 'drill.json')
		const bytes = new TextEncoder().encode('verified artifact')
		await writeFile(artifactPath, bytes)
		const localEvidence = [
			{
				artifacts: [
					{ uri: 'drill.json' },
					{ uri: pathToFileURL(artifactPath).href },
				],
			},
		]
		const verified = await verifyLocalArtifactFiles(
			localEvidence,
			path.join(directory, 'evidence.json'),
		)
		expect(verified.get('drill.json')).toBe(sha256(bytes))
		expect(verified.get(pathToFileURL(artifactPath).href)).toBe(sha256(bytes))
		await expect(
			verifyLocalArtifactFiles(
				[{ artifacts: [{ uri: 'https://example.test/evidence' }] }],
				path.join(directory, 'evidence.json'),
			),
		).rejects.toThrow('not local')
		await expect(
			verifyLocalArtifactFiles(
				[{ artifacts: [{ uri: 'missing.json' }] }],
				path.join(directory, 'evidence.json'),
			),
		).rejects.toThrow()
	} finally {
		await rm(directory, { recursive: true, force: true })
	}
})

test('code-owned readiness cadence caps evidence age regardless of decades-long expiresAt', () => {
	const cases = [
		{ resourceId: 'APP_DB', level: 'd1-only' },
		{ resourceId: 'EMAIL_BLOBS', level: 'canonical-data' },
		{ resourceId: 'VECTORIZE', level: 'full-service' },
	] as const
	for (const testCase of cases) {
		const maximumDays = maximumEvidenceAgeDays[testCase.level]
		const boundaryEvidence = completeEvidence()
		const boundaryRecord = boundaryEvidence.find(
			(item) => item.resourceId === testCase.resourceId,
		)
		if (!boundaryRecord) {
			throw new Error(`fixture lacks ${testCase.resourceId}`)
		}
		boundaryRecord.performedAt = new Date(
			now.getTime() - maximumDays * 24 * 60 * 60 * 1000,
		).toISOString()
		boundaryRecord.expiresAt = '2099-01-01T00:00:00.000Z'
		expect(
			assessCanonicalReadiness(
				boundaryEvidence,
				now,
				verifiedMap(boundaryEvidence),
			).levels[testCase.level].ready,
		).toBe(true)

		const staleEvidence = completeEvidence()
		const staleRecord = staleEvidence.find(
			(item) => item.resourceId === testCase.resourceId,
		)
		if (!staleRecord) throw new Error(`fixture lacks ${testCase.resourceId}`)
		staleRecord.performedAt = new Date(
			now.getTime() - maximumDays * 24 * 60 * 60 * 1000 - 1,
		).toISOString()
		staleRecord.expiresAt = '2099-01-01T00:00:00.000Z'
		const staleResult = assessCanonicalReadiness(
			staleEvidence,
			now,
			verifiedMap(staleEvidence),
		)
		expect(staleResult.levels[testCase.level].ready).toBe(false)
		expect(staleResult.inputFailures).toEqual(
			expect.arrayContaining([
				expect.stringContaining(`${String(maximumDays)}-day maximum age`),
			]),
		)
	}
})

test('malformed, unknown, duplicate, expired, and future evidence cannot report READY', () => {
	expect(
		assessCanonicalReadiness(
			canonicalContracts.map((contract) => `verified:${contract.id}`),
			now,
		).levels['d1-only'].ready,
	).toBe(false)

	const malformed = completeEvidence()
	malformed[0]?.artifacts.push({
		...artifact('APP_DB', 'd1-restore-drill'),
		sha256: 'ABC',
	})
	const malformedResult = assessCanonicalReadiness(malformed, now)
	expect(malformedResult.inputFailures).not.toEqual([])
	expect(malformedResult.levels['d1-only'].ready).toBe(false)

	const duplicate = [...completeEvidence(), completeEvidence()[0]]
	expect(assessCanonicalReadiness(duplicate, now).inputFailures).toEqual(
		expect.arrayContaining([expect.stringContaining('duplicate resourceId')]),
	)
	const unknown = [
		...completeEvidence(),
		{ ...completeEvidence()[0], resourceId: 'UNKNOWN_RESOURCE' },
	]
	expect(assessCanonicalReadiness(unknown, now).inputFailures).toEqual(
		expect.arrayContaining([expect.stringContaining('unknown resourceId')]),
	)

	const expired = completeEvidence()
	if (!expired[0]) throw new Error('fixture is empty')
	expired[0].expiresAt = '2026-07-22T11:00:00.000Z'
	expect(assessCanonicalReadiness(expired, now).inputFailures).toEqual(
		expect.arrayContaining([expect.stringContaining('expired')]),
	)
	const future = completeEvidence()
	if (!future[0]) throw new Error('fixture is empty')
	future[0].performedAt = '2026-07-22T13:00:00.000Z'
	expect(assessCanonicalReadiness(future, now).inputFailures).toEqual(
		expect.arrayContaining([expect.stringContaining('future')]),
	)
})
