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
const jobsSourceIdentity = {
	accountId: '0123456789abcdef0123456789abcdef',
	resourceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
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
const jobsRestoreProvenance = {
	...restoreProvenance,
	backupManifestSha256: '5'.repeat(64),
	sourceDatabaseName: 'kody-jobs',
	sqlSha256: '6'.repeat(64),
	trustedBaselineId: 'jobs-baseline-2026',
}
type SizeDetails = EvidenceDetailsByKind['d1-size-ceiling-check']
type RestoreDetails = EvidenceDetailsByKind['d1-restore-drill']
type Artifact = Record<string, unknown>
type Evidence = Array<Record<string, unknown>>

function detailsFor(
	kind: AppKind,
	identity = sourceIdentity,
	provenance = restoreProvenance,
): EvidenceDetailsByKind[AppKind] {
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
				...provenance,
				ceilingBytes: 4_500_000_000,
				measuredBytes: 1024,
				monitoredAt: performedAt,
				sourceAccountId: identity.accountId,
				sourceDatabaseUuid: identity.resourceId,
			}
		case 'd1-restore-drill':
			return {
				...provenance,
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

/** The APP_DB record's artifacts (the first evidence record). */
function appArtifacts(evidence: Evidence): Array<Artifact> {
	const record = evidence[0]
	if (!record || !Array.isArray(record.artifacts)) {
		throw new Error('fixture is malformed')
	}
	return record.artifacts as Array<Artifact>
}

function artifactOf(evidence: Evidence, kind: string): Artifact {
	const artifact = appArtifacts(evidence).find((a) => a.kind === kind)
	if (!artifact) throw new Error(`fixture lacks ${kind} artifact`)
	return artifact
}

async function assessD1(
	evidence: unknown,
	evidencePath: string,
	registry: TrustedPublicKeyRegistry,
	{
		trustedSource = sourceIdentity,
		trustedBaselineSource = sourceIdentity,
		at = now,
	} = {},
): Promise<boolean> {
	const verified = await verifyLocalArtifactFiles(
		evidence,
		evidencePath,
		registry,
	)
	return assessCanonicalReadiness(
		evidence,
		at,
		verified,
		[
			{
				accountId: trustedSource.accountId,
				databaseId: trustedSource.resourceId,
				databaseName: restoreProvenance.sourceDatabaseName,
			},
			{
				accountId: jobsSourceIdentity.accountId,
				databaseId: jobsSourceIdentity.resourceId,
				databaseName: jobsRestoreProvenance.sourceDatabaseName,
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
			{
				id: jobsRestoreProvenance.trustedBaselineId,
				canonicalSha256: jobsRestoreProvenance.trustedBaselineSha256,
				source: {
					accountId: jobsSourceIdentity.accountId,
					databaseId: jobsSourceIdentity.resourceId,
					databaseName: jobsRestoreProvenance.sourceDatabaseName,
				},
				baseline: {
					schemaSha256: jobsRestoreProvenance.schemaSha256,
					migrationNames,
					isolationChecks,
				},
			},
		],
	).levels['d1-only'].ready
}

/**
 * Writes signed APP_DB + JOBS_DB evidence into a temp directory and returns
 * helpers to assess it or re-sign APP_DB envelopes.
 */
async function createFixture(keys = generateKeyPairSync('ed25519')) {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'readiness-'))
	const envelopes: Array<SignedEvidenceEnvelope> = []
	async function writeResource(input: {
		changeId: string
		prefix: string
		resourceId: 'APP_DB' | 'JOBS_DB'
		identity: { accountId: string; resourceId: string }
		provenance: typeof restoreProvenance
	}): Promise<Record<string, unknown>> {
		const artifacts: Array<Artifact> = []
		for (const kind of appKinds) {
			const content: EvidenceContent = {
				changeId: input.changeId,
				destinationIdentity: destinationFor(kind),
				details: detailsFor(kind, input.identity, input.provenance),
				expiresAt,
				kind,
				outcome: 'passed',
				performedAt,
				resourceId: input.resourceId,
				sourceIdentity: input.identity,
				systemVersion: 'kody-build-2026.07.22',
				uri: `${input.prefix}${kind}.json`,
				verifierIdentity: 'recovery-verifier@example.test',
			}
			const envelope = signEnvelope(content, keys.privateKey)
			const bytes = Buffer.from(JSON.stringify(envelope))
			await writeFile(path.join(directory, content.uri), bytes)
			envelopes.push(envelope)
			const { details: _details, resourceId: _resourceId, ...indexed } = content
			artifacts.push({
				...indexed,
				sha256: sha256(bytes),
				type: 'application/vnd.kody.readiness-evidence+json',
			})
		}
		return {
			artifacts,
			changeId: input.changeId,
			expiresAt,
			performedAt,
			resourceId: input.resourceId,
			schemaVersion: 1,
			systemVersion: 'kody-build-2026.07.22',
			verifierIdentity: 'recovery-verifier@example.test',
		}
	}
	const evidence: Evidence = [
		await writeResource({
			changeId: 'CHG-APP-DB-RESTORE',
			prefix: '',
			resourceId: 'APP_DB',
			identity: sourceIdentity,
			provenance: restoreProvenance,
		}),
		await writeResource({
			changeId: 'CHG-JOBS-DB-RESTORE',
			prefix: 'jobs-db-',
			resourceId: 'JOBS_DB',
			identity: jobsSourceIdentity,
			provenance: jobsRestoreProvenance,
		}),
	]
	const evidencePath = path.join(directory, 'evidence.json')
	const registry = registryFor(keys.publicKey)
	const appEnvelope = (kind: AppKind) => {
		const envelope = envelopes.find(
			(e) => e.content.resourceId === 'APP_DB' && e.content.kind === kind,
		)
		if (!envelope) throw new Error(`fixture lacks ${kind} evidence`)
		return envelope
	}
	return {
		directory,
		evidence,
		envelopes,
		evidencePath,
		registry,
		privateKey: keys.privateKey,
		appEnvelope,
		appContents: () =>
			envelopes
				.filter((e) => e.content.resourceId === 'APP_DB')
				.map((e) => structuredClone(e.content)),
		ready: (
			value: unknown = evidence,
			options?: Parameters<typeof assessD1>[3],
		) => assessD1(value, evidencePath, registry, options),
		/** Overwrites the file at `uri` and returns the new bytes' digest. */
		async overwrite(uri: string, value: unknown) {
			const bytes = Buffer.from(
				typeof value === 'string' ? value : JSON.stringify(value),
			)
			await writeFile(path.join(directory, uri), bytes)
			return sha256(bytes)
		},
		/**
		 * Re-signs APP_DB contents with the fixture key and returns cloned
		 * evidence whose index matches the new digests and identities.
		 */
		async resign(contents: Array<EvidenceContent>) {
			const next = structuredClone(evidence)
			for (const content of contents) {
				const artifact = artifactOf(next, content.kind)
				artifact.sha256 = await this.overwrite(
					content.uri,
					signEnvelope(content, keys.privateKey),
				)
				artifact.sourceIdentity = content.sourceIdentity
				artifact.destinationIdentity = content.destinationIdentity
			}
			return next
		},
		[Symbol.asyncDispose]: () =>
			rm(directory, { recursive: true, force: true }),
	}
}

test('signed expiry rejects index-only extension, invalid timestamps, and code-age limits even when re-signed', async () => {
	expect(
		Object.keys(
			JSON.parse(
				canonicalJson({ é: 1, Z: 2, a: 3, A: 4, '\uE000': 5, '😀': 6 }),
			) as Record<string, unknown>,
		),
	).toEqual(['A', 'Z', 'a', 'é', '😀', '\uE000'])

	await using fixture = await createFixture()
	const inventory = fixture.appEnvelope('inventory').content
	expect(
		parseSignedEvidenceEnvelope(signEnvelope(inventory, fixture.privateKey)),
	).toBeDefined()
	for (const invalidExpiresAt of [
		performedAt,
		'2026-07-22T09:59:59.999Z',
		'2026-08-22T10:00:00Z',
		'2026-08-22T10:00:00.000+00:00',
	]) {
		expect(
			parseSignedEvidenceEnvelope(
				signEnvelope(
					{ ...inventory, expiresAt: invalidExpiresAt },
					fixture.privateKey,
				),
			),
		).toBeUndefined()
	}

	expect(await fixture.ready()).toBe(true)
	expect(
		await fixture.ready(fixture.evidence, {
			at: new Date('2026-08-23T10:00:00.000Z'),
		}),
	).toBe(false)

	const extendedExpiresAt = '2027-07-22T10:00:00.000Z'
	const indexOnlyExtension = structuredClone(fixture.evidence)
	indexOnlyExtension[0]!.expiresAt = extendedExpiresAt
	for (const artifact of appArtifacts(indexOnlyExtension)) {
		artifact.expiresAt = extendedExpiresAt
	}
	expect(await fixture.ready(indexOnlyExtension)).toBe(false)

	const contents = fixture
		.appContents()
		.map((content) => ({ ...content, expiresAt: extendedExpiresAt }))
	const reSignedExtension = await fixture.resign(contents)
	reSignedExtension[0]!.expiresAt = extendedExpiresAt
	for (const artifact of appArtifacts(reSignedExtension)) {
		artifact.expiresAt = extendedExpiresAt
	}
	expect(await fixture.ready(reSignedExtension)).toBe(true)
	expect(
		await fixture.ready(reSignedExtension, {
			at: new Date('2026-08-27T10:00:00.000Z'),
		}),
	).toBe(false)
})

test('minimal D1 readiness requires every kind-specific signed envelope', async () => {
	await using fixture = await createFixture()
	expect(await fixture.ready()).toBe(true)
	expect(
		assessCanonicalReadiness(
			fixture.evidence,
			now,
			await verifyLocalArtifactFiles(
				fixture.evidence,
				fixture.evidencePath,
				fixture.registry,
			),
		).levels['canonical-data'].ready,
	).toBe(false)

	for (const kind of appKinds) {
		const withoutKind = structuredClone(fixture.evidence).slice(0, 1)
		withoutKind[0]!.artifacts = appArtifacts(withoutKind).filter(
			(artifact) => artifact.kind !== kind,
		)
		expect(await fixture.ready(withoutKind)).toBe(false)
	}

	const size = fixture.appEnvelope('d1-size-ceiling-check').content
	for (const detailsPatch of [
		{ ceilingBytes: 5 * 1024 * 1024 * 1024 },
		{ measuredBytes: 0 },
	]) {
		const evidence = await fixture.resign([
			{
				...size,
				details: { ...(size.details as SizeDetails), ...detailsPatch },
			},
		])
		expect(await fixture.ready(evidence)).toBe(false)
	}
})

test('signed D1 provenance, restore isolation, and account identities fail closed', async () => {
	await using fixture = await createFixture()
	const verified = await verifyLocalArtifactFiles(
		fixture.evidence,
		fixture.evidencePath,
		fixture.registry,
	)
	expect(
		assessCanonicalReadiness(fixture.evidence, now, verified).levels['d1-only']
			.ready,
	).toBe(false)
	const otherSource = {
		...sourceIdentity,
		resourceId: jobsSourceIdentity.resourceId,
	}
	expect(
		await fixture.ready(fixture.evidence, { trustedSource: otherSource }),
	).toBe(false)
	expect(
		await fixture.ready(fixture.evidence, {
			trustedBaselineSource: otherSource,
		}),
	).toBe(false)

	// Positive control: re-signing unchanged content stays ready.
	expect(await fixture.ready(await fixture.resign(fixture.appContents()))).toBe(
		true,
	)
	const restore = fixture.appEnvelope('d1-restore-drill').content
	const restoreDetails = restore.details as RestoreDetails
	const restoreWith = (patch: Partial<RestoreDetails>): EvidenceContent => ({
		...restore,
		details: { ...restoreDetails, ...patch },
	})
	for (const [key, mismatch] of [
		['backupManifestSha256', 'f'.repeat(64)],
		['sqlSha256', 'f'.repeat(64)],
		['trustedBaselineId', 'different-trusted-baseline'],
		['trustedBaselineSha256', 'f'.repeat(64)],
		['schemaSha256', 'f'.repeat(64)],
		['migrationSetSha256', 'f'.repeat(64)],
		['isolationBaselineSha256', 'f'.repeat(64)],
		['restoredDatabaseUuid', '33333333-3333-4333-8333-333333333333'],
	] as const) {
		expect(
			await fixture.ready(
				await fixture.resign([restoreWith({ [key]: mismatch })]),
			),
		).toBe(false)
	}

	// Every destination-bearing APP_DB envelope re-signed to a destination that
	// overlaps the source (same account, same database, or case variants).
	for (const destination of [
		{ ...destinationIdentity, accountId: sourceIdentity.accountId },
		{ ...destinationIdentity, resourceId: sourceIdentity.resourceId },
		{
			...destinationIdentity,
			accountId: sourceIdentity.accountId.toUpperCase(),
		},
		{
			...destinationIdentity,
			resourceId: sourceIdentity.resourceId.toUpperCase(),
		},
	]) {
		const contents = fixture
			.appContents()
			.filter((content) => content.destinationIdentity !== null)
			.map((content) =>
				content.kind === 'd1-restore-drill'
					? {
							...content,
							destinationIdentity: destination,
							details: {
								...(content.details as RestoreDetails),
								restoredDatabaseUuid: destination.resourceId,
							},
						}
					: { ...content, destinationIdentity: destination },
			)
		expect(await fixture.ready(await fixture.resign(contents))).toBe(false)
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
		for (const identity of ['source', 'destination'] as const) {
			let affectedCount = 0
			const contents = fixture.appContents().map((content) => {
				if (identity === 'source') {
					content.sourceIdentity.accountId = accountId
					if (content.kind === 'd1-size-ceiling-check') {
						content.details = {
							...(content.details as SizeDetails),
							sourceAccountId: accountId,
						}
					}
				} else if (content.destinationIdentity !== null) {
					content.destinationIdentity.accountId = accountId
				} else {
					expect(
						parseSignedEvidenceEnvelope(
							signEnvelope(content, fixture.privateKey),
						),
					).toBeDefined()
					return content
				}
				affectedCount += 1
				expect(
					parseSignedEvidenceEnvelope(
						signEnvelope(content, fixture.privateKey),
					),
				).toBeUndefined()
				return content
			})
			const evidence = await fixture.resign(contents)
			const nextVerified = await verifyLocalArtifactFiles(
				evidence,
				fixture.evidencePath,
				fixture.registry,
			)
			expect(nextVerified.size).toBe(fixture.envelopes.length - affectedCount)
			expect(
				assessCanonicalReadiness(evidence, now, nextVerified).levels['d1-only'],
			).toMatchObject({ ready: false })
		}
	}
})

test('unsigned, forged, untrusted, and duplicate evidence fail closed', async () => {
	await using fixture = await createFixture()
	const untrusted = generateKeyPairSync('ed25519')
	const firstEnvelope = fixture.envelopes[0]!
	const firstUri = firstEnvelope.content.uri

	async function expectEnvelopeNotReady(value: unknown) {
		const evidence = structuredClone(fixture.evidence)
		appArtifacts(evidence)[0]!.sha256 = await fixture.overwrite(firstUri, value)
		expect(await fixture.ready(evidence)).toBe(false)
	}

	await expectEnvelopeNotReady('synthetic arbitrary artifact bytes')
	const { signature: _omittedSignature, ...unsigned } = firstEnvelope
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
			details: { credentialId: 'source-edit-token', scope: 'Account D1 Edit' },
			kind: 'source-credential-check',
		},
		{
			...firstEnvelope.content,
			sourceIdentity: {
				...firstEnvelope.content.sourceIdentity,
				accountId: 'different-account',
			},
		},
		{ ...firstEnvelope.content, performedAt: '2026-07-22T09:59:59.000Z' },
		{ ...firstEnvelope.content, uri: 'different-uri.json' },
		{ ...firstEnvelope.content, systemVersion: 'different-build' },
	]
	for (const content of signedMismatches) {
		await expectEnvelopeNotReady(signEnvelope(content, fixture.privateKey))
	}
	await expectEnvelopeNotReady({
		...firstEnvelope,
		content: { ...firstEnvelope.content, outcome: 'failed' },
	})
	await expectEnvelopeNotReady({ ...firstEnvelope, schemaVersion: 2 })

	await fixture.overwrite(firstUri, firstEnvelope)
	const digestMismatch = structuredClone(fixture.evidence)
	appArtifacts(digestMismatch)[0]!.sha256 = '0'.repeat(64)
	expect(await fixture.ready(digestMismatch)).toBe(false)

	const duplicateUri = structuredClone(fixture.evidence)
	appArtifacts(duplicateUri)[1]!.uri = firstUri
	expect(await fixture.ready(duplicateUri)).toBe(false)

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
		await assessD1(fixture.evidence, fixture.evidencePath, checkedRegistry),
	).toBe(false)
})

test('readiness artifact URIs cannot escape the evidence directory', async () => {
	await using evidenceRoot = await createFixture()
	const outsideDirectory = await mkdtemp(
		path.join(os.tmpdir(), 'readiness-evidence-outside-'),
	)
	try {
		const outsideFile = path.join(outsideDirectory, 'outside.json')
		await writeFile(outsideFile, '{}')
		for (const uri of ['../outside.json', pathToFileURL(outsideFile).href]) {
			await expect(
				verifyLocalArtifactFiles(
					[{ artifacts: [{ uri }] }],
					evidenceRoot.evidencePath,
					evidenceRoot.registry,
				),
			).rejects.toThrow('escapes the evidence directory')
		}
	} finally {
		await rm(outsideDirectory, { recursive: true, force: true })
	}
})
