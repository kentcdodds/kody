import {
	generateKeyPairSync,
	sign as signBytes,
	type KeyObject,
} from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test } from 'vitest'
import {
	type EvidenceContent,
	type EvidenceDetailsByKind,
	type EvidenceKind,
	type SignedEvidenceEnvelope,
	assessCanonicalReadiness,
	canonicalEvidencePayload,
	parseSignedEvidenceEnvelope,
} from './canonical-readiness.ts'
import {
	type TrustedPublicKeyRegistry,
	parseTrustedPublicKeyRegistry,
	verifyLocalArtifactFiles,
} from './canonical-readiness-cli.ts'
import { canonicalJson, sha256 } from './canonical-json.ts'

const appKinds = [
	'inventory',
	'source-credential-check',
	'destination-credential-check',
	'transfer-support-check',
	'contract-verification',
	'd1-size-ceiling-check',
	'd1-restore-drill',
] as const satisfies ReadonlyArray<EvidenceKind>
type AppKind = (typeof appKinds)[number]

const performedAt = '2026-07-22T10:00:00.000Z'
const expiresAt = '2026-08-22T10:00:00.000Z'
const now = new Date('2026-07-22T12:00:00.000Z')
const sourceIdentity = {
	accountId: '0123456789abcdef0123456789abcdef',
	resourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
}
const destinationIdentity = {
	accountId: 'fedcba9876543210fedcba9876543210',
	resourceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
}
const migrationNames = ['0001-initial.sql']
const isolationChecks: Array<unknown> = []
const restoreProvenance = {
	backupManifestSha256: '1'.repeat(64),
	isolationBaselineSha256: sha256(canonicalJson(isolationChecks)),
	migrationSetSha256: sha256(canonicalJson(migrationNames)),
	schemaSha256: '3'.repeat(64),
	sourceBookmark: 'bookmark-1',
	sourceDatabaseName: 'kody-production',
	sqlSha256: '2'.repeat(64),
	trustedBaselineId: 'production-baseline-2026',
	trustedBaselineSha256: '4'.repeat(64),
}

function detailsFor(kind: AppKind): EvidenceDetailsByKind[AppKind] {
	switch (kind) {
		case 'inventory':
			return { inventorySha256: '1'.repeat(64), itemCount: 1 }
		case 'source-credential-check':
			return { credentialId: 'source-edit-token', scope: 'Account D1 Edit' }
		case 'destination-credential-check':
			return {
				credentialId: 'destination-edit-token',
				scope: 'Account D1 Edit',
			}
		case 'transfer-support-check':
			return { mechanism: 'd1-logical-import', supported: true }
		case 'contract-verification':
			return { checksPassed: 5, contractVersion: '2026-07-22' }
		case 'd1-size-ceiling-check':
			return {
				...restoreProvenance,
				ceilingBytes: 4_500_000_000,
				measuredBytes: 1024,
				monitoredAt: performedAt,
				sourceAccountId: sourceIdentity.accountId,
				sourceDatabaseUuid: sourceIdentity.resourceId,
			}
		case 'd1-restore-drill':
			return {
				...restoreProvenance,
				foreignKeyViolations: 0,
				quickCheck: 'ok',
				restoredDatabaseUuid: destinationIdentity.resourceId,
			}
		default: {
			const exhaustive: never = kind
			throw new Error(String(exhaustive))
		}
	}
}

function destinationFor(kind: AppKind) {
	return kind === 'inventory' ||
		kind === 'source-credential-check' ||
		kind === 'd1-size-ceiling-check'
		? null
		: destinationIdentity
}

function signEnvelope(
	content: EvidenceContent,
	privateKey: KeyObject,
	keyId = 'readiness-2026',
): SignedEvidenceEnvelope {
	const unsigned = { schemaVersion: 1 as const, content }
	return {
		...unsigned,
		signature: {
			algorithm: 'Ed25519',
			keyId,
			value: signBytes(
				null,
				Buffer.from(canonicalEvidencePayload(unsigned)),
				privateKey,
			).toString('base64'),
		},
	}
}

async function createFixture(
	directory: string,
	privateKey: KeyObject,
): Promise<{
	evidence: Array<Record<string, unknown>>
	envelopes: Array<SignedEvidenceEnvelope>
	evidencePath: string
}> {
	const envelopes: Array<SignedEvidenceEnvelope> = []
	const artifacts: Array<Record<string, unknown>> = []
	for (const kind of appKinds) {
		const uri = `${kind}.json`
		const content: EvidenceContent = {
			changeId: 'CHG-APP-DB-RESTORE',
			destinationIdentity: destinationFor(kind),
			details: detailsFor(kind),
			expiresAt,
			kind,
			outcome: 'passed',
			performedAt,
			resourceId: 'APP_DB',
			sourceIdentity,
			systemVersion: 'kody-build-2026.07.22',
			uri,
			verifierIdentity: 'recovery-verifier@example.test',
		}
		const envelope = signEnvelope(content, privateKey)
		const bytes = Buffer.from(JSON.stringify(envelope))
		await writeFile(path.join(directory, uri), bytes)
		envelopes.push(envelope)
		artifacts.push({
			changeId: content.changeId,
			destinationIdentity: content.destinationIdentity,
			expiresAt: content.expiresAt,
			kind: content.kind,
			outcome: content.outcome,
			performedAt: content.performedAt,
			sha256: sha256(bytes),
			sourceIdentity: content.sourceIdentity,
			systemVersion: content.systemVersion,
			type: 'application/vnd.kody.readiness-evidence+json',
			uri: content.uri,
			verifierIdentity: content.verifierIdentity,
		})
	}
	return {
		evidence: [
			{
				artifacts,
				changeId: 'CHG-APP-DB-RESTORE',
				expiresAt,
				performedAt,
				resourceId: 'APP_DB',
				schemaVersion: 1,
				systemVersion: 'kody-build-2026.07.22',
				verifierIdentity: 'recovery-verifier@example.test',
			},
		],
		envelopes,
		evidencePath: path.join(directory, 'evidence.json'),
	}
}

function registryFor(publicKey: KeyObject): TrustedPublicKeyRegistry {
	return {
		schemaVersion: 1,
		keys: [
			{
				algorithm: 'Ed25519',
				keyId: 'readiness-2026',
				publicKeyPem: publicKey.export({
					format: 'pem',
					type: 'spki',
				}) as string,
			},
		],
	}
}

async function isD1Ready(
	evidence: unknown,
	evidencePath: string,
	registry: TrustedPublicKeyRegistry,
	trustedSource = sourceIdentity,
	trustedBaselineSource = sourceIdentity,
	assessmentTime = now,
): Promise<boolean> {
	const verified = await verifyLocalArtifactFiles(
		evidence,
		evidencePath,
		registry,
	)
	return assessCanonicalReadiness(
		evidence,
		assessmentTime,
		verified,
		[
			{
				accountId: trustedSource.accountId,
				databaseId: trustedSource.resourceId,
				databaseName: restoreProvenance.sourceDatabaseName,
			},
		],
		[
			{
				id: restoreProvenance.trustedBaselineId,
				canonicalSha256: restoreProvenance.trustedBaselineSha256,
				source: {
					accountId: trustedBaselineSource.accountId,
					databaseId: trustedBaselineSource.resourceId,
					databaseName: restoreProvenance.sourceDatabaseName,
				},
				baseline: {
					schemaSha256: restoreProvenance.schemaSha256,
					migrationNames,
					isolationChecks,
				},
			},
		],
	).levels['d1-only'].ready
}

test('signed expiry rejects index-only extension, invalid timestamps, and code-age limits even when re-signed', async () => {
	expect(
		Object.keys(
			JSON.parse(
				canonicalJson({
					é: 1,
					Z: 2,
					a: 3,
					A: 4,
					'\uE000': 5,
					'😀': 6,
				}),
			) as Record<string, unknown>,
		),
	).toEqual(['A', 'Z', 'a', 'é', '😀', '\uE000'])

	const directory = await mkdtemp(
		path.join(os.tmpdir(), 'readiness-signed-expiry-'),
	)
	try {
		const { privateKey, publicKey } = generateKeyPairSync('ed25519')
		const content: EvidenceContent = {
			changeId: 'CHG-APP-DB-RESTORE',
			destinationIdentity: null,
			details: detailsFor('inventory'),
			expiresAt,
			kind: 'inventory',
			outcome: 'passed',
			performedAt,
			resourceId: 'APP_DB',
			sourceIdentity,
			systemVersion: 'kody-build-2026.07.22',
			uri: 'inventory.json',
			verifierIdentity: 'recovery-verifier@example.test',
		}
		expect(
			parseSignedEvidenceEnvelope(signEnvelope(content, privateKey)),
		).toBeDefined()
		for (const invalidExpiresAt of [
			performedAt,
			'2026-07-22T09:59:59.999Z',
			'2026-08-22T10:00:00Z',
			'2026-08-22T10:00:00.000+00:00',
		]) {
			expect(
				parseSignedEvidenceEnvelope(
					signEnvelope({ ...content, expiresAt: invalidExpiresAt }, privateKey),
				),
			).toBeUndefined()
		}

		const fixture = await createFixture(directory, privateKey)
		const registry = registryFor(publicKey)
		expect(
			await isD1Ready(fixture.evidence, fixture.evidencePath, registry),
		).toBe(true)
		expect(
			await isD1Ready(
				fixture.evidence,
				fixture.evidencePath,
				registry,
				sourceIdentity,
				sourceIdentity,
				new Date('2026-08-23T10:00:00.000Z'),
			),
		).toBe(false)

		const extendedExpiresAt = '2027-07-22T10:00:00.000Z'
		const indexOnlyExtension = structuredClone(fixture.evidence)
		const indexOnlyRecord = indexOnlyExtension[0]
		if (!indexOnlyRecord || !Array.isArray(indexOnlyRecord.artifacts)) {
			throw new Error('fixture is malformed')
		}
		indexOnlyRecord.expiresAt = extendedExpiresAt
		for (const artifact of indexOnlyRecord.artifacts) {
			;(artifact as Record<string, unknown>).expiresAt = extendedExpiresAt
		}
		expect(
			await isD1Ready(indexOnlyExtension, fixture.evidencePath, registry),
		).toBe(false)

		const reSignedExtension = structuredClone(fixture.evidence)
		const reSignedRecord = reSignedExtension[0]
		if (!reSignedRecord || !Array.isArray(reSignedRecord.artifacts)) {
			throw new Error('fixture is malformed')
		}
		reSignedRecord.expiresAt = extendedExpiresAt
		for (const envelope of fixture.envelopes) {
			const extendedEnvelope = signEnvelope(
				{ ...envelope.content, expiresAt: extendedExpiresAt },
				privateKey,
			)
			const bytes = Buffer.from(JSON.stringify(extendedEnvelope))
			await writeFile(path.join(directory, extendedEnvelope.content.uri), bytes)
			const artifact = reSignedRecord.artifacts.find(
				(candidate) =>
					(candidate as Record<string, unknown>).kind ===
					extendedEnvelope.content.kind,
			) as Record<string, unknown> | undefined
			if (!artifact) {
				throw new Error(
					`fixture lacks ${extendedEnvelope.content.kind} artifact`,
				)
			}
			artifact.expiresAt = extendedExpiresAt
			artifact.sha256 = sha256(bytes)
		}
		expect(
			await isD1Ready(reSignedExtension, fixture.evidencePath, registry),
		).toBe(true)
		expect(
			await isD1Ready(
				reSignedExtension,
				fixture.evidencePath,
				registry,
				sourceIdentity,
				sourceIdentity,
				new Date('2026-08-27T10:00:00.000Z'),
			),
		).toBe(false)
	} finally {
		await rm(directory, { recursive: true, force: true })
	}
})

test('minimal D1 readiness requires every kind-specific signed envelope', async () => {
	const directory = await mkdtemp(
		path.join(os.tmpdir(), 'readiness-signatures-'),
	)
	try {
		const { privateKey, publicKey } = generateKeyPairSync('ed25519')
		const fixture = await createFixture(directory, privateKey)
		const registry = registryFor(publicKey)
		expect(
			await isD1Ready(fixture.evidence, fixture.evidencePath, registry),
		).toBe(true)
		expect(
			assessCanonicalReadiness(
				fixture.evidence,
				now,
				await verifyLocalArtifactFiles(
					fixture.evidence,
					fixture.evidencePath,
					registry,
				),
			).levels['canonical-data'].ready,
		).toBe(false)

		for (const kind of appKinds) {
			const record = fixture.evidence[0]
			if (!record || !Array.isArray(record.artifacts)) {
				throw new Error('fixture is malformed')
			}
			const withoutKind = [
				{
					...record,
					artifacts: record.artifacts.filter(
						(artifact) => (artifact as Record<string, unknown>).kind !== kind,
					),
				},
			]
			expect(await isD1Ready(withoutKind, fixture.evidencePath, registry)).toBe(
				false,
			)
		}
		const sizeEnvelope = fixture.envelopes.find(
			(envelope) => envelope.content.kind === 'd1-size-ceiling-check',
		)
		const evidenceRecord = fixture.evidence[0]
		if (
			!sizeEnvelope ||
			!evidenceRecord ||
			!Array.isArray(evidenceRecord.artifacts)
		) {
			throw new Error('fixture lacks size-ceiling evidence')
		}
		const unsupportedCeiling = signEnvelope(
			{
				...sizeEnvelope.content,
				details: {
					...(sizeEnvelope.content
						.details as EvidenceDetailsByKind['d1-size-ceiling-check']),
					ceilingBytes: 5 * 1024 * 1024 * 1024,
				},
			},
			privateKey,
		)
		const unsupportedBytes = Buffer.from(JSON.stringify(unsupportedCeiling))
		await writeFile(
			path.join(directory, unsupportedCeiling.content.uri),
			unsupportedBytes,
		)
		const unsupportedEvidence = structuredClone(fixture.evidence)
		const unsupportedRecord = unsupportedEvidence[0]
		if (!unsupportedRecord || !Array.isArray(unsupportedRecord.artifacts)) {
			throw new Error('fixture is malformed')
		}
		const sizeArtifact = unsupportedRecord.artifacts.find(
			(artifact) =>
				(artifact as Record<string, unknown>).kind === 'd1-size-ceiling-check',
		) as Record<string, unknown> | undefined
		if (!sizeArtifact) throw new Error('fixture lacks size artifact')
		sizeArtifact.sha256 = sha256(unsupportedBytes)
		expect(
			await isD1Ready(unsupportedEvidence, fixture.evidencePath, registry),
		).toBe(false)
		const zeroMeasurement = signEnvelope(
			{
				...sizeEnvelope.content,
				details: {
					...(sizeEnvelope.content
						.details as EvidenceDetailsByKind['d1-size-ceiling-check']),
					measuredBytes: 0,
				},
			},
			privateKey,
		)
		const zeroBytes = Buffer.from(JSON.stringify(zeroMeasurement))
		await writeFile(
			path.join(directory, zeroMeasurement.content.uri),
			zeroBytes,
		)
		const zeroEvidence = structuredClone(fixture.evidence)
		const zeroRecord = zeroEvidence[0]
		if (!zeroRecord || !Array.isArray(zeroRecord.artifacts)) {
			throw new Error('fixture is malformed')
		}
		const zeroArtifact = zeroRecord.artifacts.find(
			(artifact) =>
				(artifact as Record<string, unknown>).kind === 'd1-size-ceiling-check',
		) as Record<string, unknown> | undefined
		if (!zeroArtifact) throw new Error('fixture lacks size artifact')
		zeroArtifact.sha256 = sha256(zeroBytes)
		expect(await isD1Ready(zeroEvidence, fixture.evidencePath, registry)).toBe(
			false,
		)
	} finally {
		await rm(directory, { recursive: true, force: true })
	}
})

test('signed D1 provenance, restore isolation, and account identities fail closed', async () => {
	const directory = await mkdtemp(
		path.join(os.tmpdir(), 'readiness-provenance-'),
	)
	try {
		const { privateKey, publicKey } = generateKeyPairSync('ed25519')
		const fixture = await createFixture(directory, privateKey)
		const registry = registryFor(publicKey)
		const verified = await verifyLocalArtifactFiles(
			fixture.evidence,
			fixture.evidencePath,
			registry,
		)
		expect(
			assessCanonicalReadiness(fixture.evidence, now, verified).levels[
				'd1-only'
			].ready,
		).toBe(false)
		expect(
			await isD1Ready(fixture.evidence, fixture.evidencePath, registry, {
				...sourceIdentity,
				resourceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
			}),
		).toBe(false)
		expect(
			await isD1Ready(
				fixture.evidence,
				fixture.evidencePath,
				registry,
				sourceIdentity,
				{
					...sourceIdentity,
					resourceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
				},
			),
		).toBe(false)

		const restoreEnvelope = fixture.envelopes.find(
			(envelope) => envelope.content.kind === 'd1-restore-drill',
		)
		if (!restoreEnvelope) throw new Error('fixture lacks restore evidence')
		for (const [key, mismatch] of [
			['backupManifestSha256', 'f'.repeat(64)],
			['sqlSha256', 'f'.repeat(64)],
			['trustedBaselineId', 'different-trusted-baseline'],
			['trustedBaselineSha256', 'f'.repeat(64)],
			['schemaSha256', 'f'.repeat(64)],
			['migrationSetSha256', 'f'.repeat(64)],
			['isolationBaselineSha256', 'f'.repeat(64)],
		] as const) {
			const content = structuredClone(restoreEnvelope.content)
			const details =
				content.details as EvidenceDetailsByKind['d1-restore-drill']
			details[key] = mismatch
			const signed = signEnvelope(content, privateKey)
			const bytes = Buffer.from(JSON.stringify(signed))
			await writeFile(path.join(directory, content.uri), bytes)
			const evidence = structuredClone(fixture.evidence)
			const record = evidence[0]
			if (!record || !Array.isArray(record.artifacts)) {
				throw new Error('fixture is malformed')
			}
			const artifact = record.artifacts.find(
				(candidate) =>
					(candidate as Record<string, unknown>).kind === 'd1-restore-drill',
			) as Record<string, unknown> | undefined
			if (!artifact) throw new Error('fixture lacks restore artifact')
			artifact.sha256 = sha256(bytes)
			expect(await isD1Ready(evidence, fixture.evidencePath, registry)).toBe(
				false,
			)
		}

		async function expectRestoreContentNotReady(
			content: EvidenceContent,
		): Promise<void> {
			const signed = signEnvelope(content, privateKey)
			const bytes = Buffer.from(JSON.stringify(signed))
			await writeFile(path.join(directory, content.uri), bytes)
			const evidence = structuredClone(fixture.evidence)
			const record = evidence[0]
			if (!record || !Array.isArray(record.artifacts)) {
				throw new Error('fixture is malformed')
			}
			const artifact = record.artifacts.find(
				(candidate) =>
					(candidate as Record<string, unknown>).kind === 'd1-restore-drill',
			) as Record<string, unknown> | undefined
			if (!artifact) throw new Error('fixture lacks restore artifact')
			artifact.sha256 = sha256(bytes)
			artifact.sourceIdentity = content.sourceIdentity
			artifact.destinationIdentity = content.destinationIdentity
			expect(await isD1Ready(evidence, fixture.evidencePath, registry)).toBe(
				false,
			)
		}

		async function expectDestinationNotReady(
			destination: typeof destinationIdentity,
		): Promise<void> {
			const evidence = structuredClone(fixture.evidence)
			const record = evidence[0]
			if (!record || !Array.isArray(record.artifacts)) {
				throw new Error('fixture is malformed')
			}
			for (const envelope of fixture.envelopes) {
				if (envelope.content.destinationIdentity === null) continue
				const content: EvidenceContent =
					envelope.content.kind === 'd1-restore-drill'
						? {
								...envelope.content,
								destinationIdentity: destination,
								details: {
									...(envelope.content
										.details as EvidenceDetailsByKind['d1-restore-drill']),
									restoredDatabaseUuid: destination.resourceId,
								},
							}
						: {
								...envelope.content,
								destinationIdentity: destination,
							}
				const signed = signEnvelope(content, privateKey)
				const bytes = Buffer.from(JSON.stringify(signed))
				await writeFile(path.join(directory, content.uri), bytes)
				const artifact = record.artifacts.find(
					(candidate) =>
						(candidate as Record<string, unknown>).kind === content.kind,
				) as Record<string, unknown> | undefined
				if (!artifact) throw new Error(`fixture lacks ${content.kind} artifact`)
				artifact.sha256 = sha256(bytes)
				artifact.destinationIdentity = destination
			}
			expect(await isD1Ready(evidence, fixture.evidencePath, registry)).toBe(
				false,
			)
		}

		await expectRestoreContentNotReady({
			...restoreEnvelope.content,
			details: {
				...(restoreEnvelope.content
					.details as EvidenceDetailsByKind['d1-restore-drill']),
				restoredDatabaseUuid: '33333333-3333-4333-8333-333333333333',
			},
		})
		await expectDestinationNotReady({
			...destinationIdentity,
			accountId: sourceIdentity.accountId,
		})
		await expectDestinationNotReady({
			...destinationIdentity,
			resourceId: sourceIdentity.resourceId,
		})
		await expectDestinationNotReady({
			...destinationIdentity,
			accountId: sourceIdentity.accountId.toUpperCase(),
		})
		await expectDestinationNotReady({
			...destinationIdentity,
			resourceId: sourceIdentity.resourceId.toUpperCase(),
		})

		async function expectAccountIdNotReady(
			identity: 'source' | 'destination',
			accountId: string,
		): Promise<void> {
			const evidence = structuredClone(fixture.evidence)
			const record = evidence[0]
			if (!record || !Array.isArray(record.artifacts)) {
				throw new Error('fixture is malformed')
			}
			let affectedEnvelopeCount = 0
			for (const envelope of fixture.envelopes) {
				const content = structuredClone(envelope.content)
				let affected = false
				if (identity === 'source') {
					content.sourceIdentity.accountId = accountId
					if (content.kind === 'd1-size-ceiling-check') {
						content.details = {
							...(content.details as EvidenceDetailsByKind['d1-size-ceiling-check']),
							sourceAccountId: accountId,
						}
					}
					affected = true
				} else if (content.destinationIdentity !== null) {
					content.destinationIdentity.accountId = accountId
					affected = true
				}
				const signed = signEnvelope(content, privateKey)
				expect(parseSignedEvidenceEnvelope(signed) !== undefined).toBe(
					!affected,
				)
				const bytes = Buffer.from(JSON.stringify(signed))
				await writeFile(path.join(directory, content.uri), bytes)
				const artifact = record.artifacts.find(
					(candidate) =>
						(candidate as Record<string, unknown>).kind === content.kind,
				) as Record<string, unknown> | undefined
				if (!artifact) throw new Error(`fixture lacks ${content.kind} artifact`)
				artifact.sha256 = sha256(bytes)
				artifact.sourceIdentity = content.sourceIdentity
				artifact.destinationIdentity = content.destinationIdentity
				if (affected) affectedEnvelopeCount += 1
			}
			const nextVerified = await verifyLocalArtifactFiles(
				evidence,
				fixture.evidencePath,
				registry,
			)
			expect(nextVerified.size).toBe(
				fixture.envelopes.length - affectedEnvelopeCount,
			)
			expect(
				assessCanonicalReadiness(evidence, now, nextVerified).levels['d1-only'],
			).toMatchObject({ ready: false })
		}

		const invalidAccountIds = [
			` ${sourceIdentity.accountId}`,
			`${sourceIdentity.accountId} `,
			`${sourceIdentity.accountId.slice(0, 16)} ${sourceIdentity.accountId.slice(16)}`,
			sourceIdentity.accountId.toUpperCase(),
			sourceIdentity.accountId.slice(1),
			`${sourceIdentity.accountId.slice(0, -1)}g`,
			`${sourceIdentity.accountId.slice(0, -1)}\u0430`,
		]
		for (const accountId of invalidAccountIds) {
			await expectAccountIdNotReady('source', accountId)
			await expectAccountIdNotReady('destination', accountId)
		}
	} finally {
		await rm(directory, { recursive: true, force: true })
	}
})

test('unsigned, forged, untrusted, and duplicate evidence fail closed', async () => {
	const directory = await mkdtemp(
		path.join(os.tmpdir(), 'readiness-forgeries-'),
	)
	try {
		const trusted = generateKeyPairSync('ed25519')
		const untrusted = generateKeyPairSync('ed25519')
		const fixture = await createFixture(directory, trusted.privateKey)
		const registry = registryFor(trusted.publicKey)
		const firstEnvelope = fixture.envelopes[0]
		const firstRecord = fixture.evidence[0]
		if (
			!firstEnvelope ||
			!firstRecord ||
			!Array.isArray(firstRecord.artifacts)
		) {
			throw new Error('fixture is malformed')
		}
		const firstArtifact = firstRecord.artifacts[0] as Record<string, unknown>
		const firstPath = path.join(directory, firstEnvelope.content.uri)

		async function expectEnvelopeNotReady(value: unknown): Promise<void> {
			const bytes = Buffer.from(
				typeof value === 'string' ? value : JSON.stringify(value),
			)
			await writeFile(firstPath, bytes)
			const indexedEvidence = structuredClone(fixture.evidence)
			const indexedRecord = indexedEvidence[0]
			if (!indexedRecord || !Array.isArray(indexedRecord.artifacts)) {
				throw new Error('fixture is malformed')
			}
			const indexedArtifact = indexedRecord.artifacts[0] as Record<
				string,
				unknown
			>
			indexedArtifact.sha256 = sha256(bytes)
			expect(
				await isD1Ready(indexedEvidence, fixture.evidencePath, registry),
			).toBe(false)
		}

		await expectEnvelopeNotReady('synthetic arbitrary artifact bytes')

		const { signature: omittedSignature, ...unsigned } = firstEnvelope
		expect(omittedSignature.algorithm).toBe('Ed25519')
		await expectEnvelopeNotReady(unsigned)

		await expectEnvelopeNotReady(
			signEnvelope(firstEnvelope.content, untrusted.privateKey),
		)

		const forged = structuredClone(firstEnvelope)
		forged.content.changeId = 'FORGED-CHANGE'
		await expectEnvelopeNotReady(forged)

		const signedMismatches: Array<EvidenceContent> = [
			{ ...firstEnvelope.content, resourceId: 'EMAIL_BLOBS' },
			{
				...firstEnvelope.content,
				details: {
					credentialId: 'source-edit-token',
					scope: 'Account D1 Edit',
				},
				kind: 'source-credential-check',
			},
			{
				...firstEnvelope.content,
				sourceIdentity: {
					...firstEnvelope.content.sourceIdentity,
					accountId: 'different-account',
				},
			},
			{
				...firstEnvelope.content,
				performedAt: '2026-07-22T09:59:59.000Z',
			},
			{ ...firstEnvelope.content, uri: 'different-uri.json' },
			{
				...firstEnvelope.content,
				systemVersion: 'different-build',
			},
		]
		for (const content of signedMismatches) {
			await expectEnvelopeNotReady(signEnvelope(content, trusted.privateKey))
		}

		await expectEnvelopeNotReady({
			...firstEnvelope,
			content: { ...firstEnvelope.content, outcome: 'failed' },
		})
		await expectEnvelopeNotReady({ ...firstEnvelope, schemaVersion: 2 })

		await writeFile(firstPath, JSON.stringify(firstEnvelope))
		const digestMismatch = structuredClone(fixture.evidence)
		const digestRecord = digestMismatch[0]
		if (!digestRecord || !Array.isArray(digestRecord.artifacts)) {
			throw new Error('fixture is malformed')
		}
		;(digestRecord.artifacts[0] as Record<string, unknown>).sha256 = '0'.repeat(
			64,
		)
		expect(
			await isD1Ready(digestMismatch, fixture.evidencePath, registry),
		).toBe(false)

		const duplicateUri = structuredClone(fixture.evidence)
		const duplicateRecord = duplicateUri[0]
		if (!duplicateRecord || !Array.isArray(duplicateRecord.artifacts)) {
			throw new Error('fixture is malformed')
		}
		const secondArtifact = duplicateRecord.artifacts[1] as Record<
			string,
			unknown
		>
		secondArtifact.uri = firstArtifact.uri
		expect(await isD1Ready(duplicateUri, fixture.evidencePath, registry)).toBe(
			false,
		)

		const checkedRegistry = parseTrustedPublicKeyRegistry(
			JSON.parse(
				await readFile(
					new URL('./trusted-readiness-public-keys.json', import.meta.url),
					'utf8',
				),
			) as unknown,
		)
		expect(checkedRegistry.keys).toEqual([])
		expect(
			await isD1Ready(fixture.evidence, fixture.evidencePath, checkedRegistry),
		).toBe(false)
	} finally {
		await rm(directory, { recursive: true, force: true })
	}
})

test('readiness artifact URIs cannot escape the evidence directory', async () => {
	const evidenceDirectory = await mkdtemp(
		path.join(os.tmpdir(), 'readiness-evidence-root-'),
	)
	const outsideDirectory = await mkdtemp(
		path.join(os.tmpdir(), 'readiness-evidence-outside-'),
	)
	try {
		const outsideFile = path.join(outsideDirectory, 'outside.json')
		await writeFile(outsideFile, '{}')
		const { publicKey } = generateKeyPairSync('ed25519')
		const registry = registryFor(publicKey)
		const evidencePath = path.join(evidenceDirectory, 'evidence.json')
		await expect(
			verifyLocalArtifactFiles(
				[{ artifacts: [{ uri: '../outside.json' }] }],
				evidencePath,
				registry,
			),
		).rejects.toThrow('escapes the evidence directory')
		await expect(
			verifyLocalArtifactFiles(
				[{ artifacts: [{ uri: pathToFileURL(outsideFile).href }] }],
				evidencePath,
				registry,
			),
		).rejects.toThrow('escapes the evidence directory')
	} finally {
		await rm(evidenceDirectory, { recursive: true, force: true })
		await rm(outsideDirectory, { recursive: true, force: true })
	}
})
