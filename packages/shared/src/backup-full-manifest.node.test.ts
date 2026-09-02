import { generateKeyPairSync, sign as signBytes } from 'node:crypto'

import { expect, test } from 'vitest'

import {
	backupFullManifestLegacySchemaVersion,
	backupFullManifestSchemaVersion,
	backupFullManifestSignatureAlgorithm,
	canonicalBackupFullManifestPayload,
	parseBackupFullManifest,
	serializeBackupFullManifest,
	type BackupFullManifest,
	type BackupFullManifestPayload,
} from './backup-full-manifest.ts'

function samplePayload(): BackupFullManifestPayload {
	return {
		schemaVersion: backupFullManifestSchemaVersion,
		day: '2026-07-22',
		d1ManifestKey: 'daily/d1/db/2026-07-22/manifest.json',
		d1ManifestSha256: 'a'.repeat(64),
		storageIndex: {
			objectKey: 'daily/full/2026-07-22/storage-index.json',
			bytes: 12,
			sha256: 'b'.repeat(64),
		},
		mailboxIndex: {
			objectKey: 'daily/full/2026-07-22/mailbox-index.json',
			bytes: 10,
			sha256: 'e'.repeat(64),
		},
		runLogIndex: {
			objectKey: 'daily/full/2026-07-22/run-log-index.json',
			bytes: 11,
			sha256: 'f'.repeat(64),
		},
		r2Indexes: {
			'email-blobs': {
				objectKey: 'daily/full/2026-07-22/r2-index/email-blobs.ndjson',
				bytes: 8,
				sha256: 'c'.repeat(64),
			},
		},
		artifactsIndex: {
			objectKey: 'daily/full/2026-07-22/artifacts-index.json',
			bytes: 4,
			sha256: 'd'.repeat(64),
		},
		sealedAt: '2026-07-22T12:00:00.000Z',
		buildCommit: 'abc123',
		signing: {
			algorithm: backupFullManifestSignatureAlgorithm,
			keyId: 'backup-manifest-2026',
		},
	}
}

function signedManifest(
	payload: BackupFullManifestPayload,
): BackupFullManifest {
	const { privateKey } = generateKeyPairSync('ed25519')
	return {
		schemaVersion: backupFullManifestSchemaVersion,
		payload,
		signature: {
			algorithm: backupFullManifestSignatureAlgorithm,
			keyId: payload.signing.keyId,
			value: signBytes(
				null,
				Buffer.from(canonicalBackupFullManifestPayload(payload)),
				privateKey,
			).toString('base64'),
		},
	}
}

test('parseBackupFullManifest accepts a signed envelope and rejects shape drift', () => {
	const manifest = signedManifest(samplePayload())
	expect(parseBackupFullManifest(manifest)).toEqual(manifest)
	expect(serializeBackupFullManifest(manifest).endsWith('\n')).toBe(true)

	expect(() =>
		parseBackupFullManifest({
			...manifest,
			extra: true,
		}),
	).toThrow(/invalid versioned shape/)
	expect(() =>
		parseBackupFullManifest({
			...manifest,
			payload: { ...manifest.payload, day: '22-07-2026' },
		}),
	).toThrow(/invalid signed values/)
	expect(() =>
		parseBackupFullManifest({
			...manifest,
			payload: {
				...manifest.payload,
				r2Indexes: {
					'not-a-bucket': manifest.payload.storageIndex,
				},
			},
		}),
	).toThrow(/invalid signed values/)

	const {
		mailboxIndex: _mailboxIndex,
		runLogIndex: _runLogIndex,
		...legacy
	} = manifest.payload
	expect(
		parseBackupFullManifest({
			...manifest,
			schemaVersion: backupFullManifestLegacySchemaVersion,
			payload: {
				...legacy,
				schemaVersion: backupFullManifestLegacySchemaVersion,
			},
		}).payload.schemaVersion,
	).toBe(backupFullManifestLegacySchemaVersion)
})

test('parseBackupFullManifest accepts declared d1Sources and keeps historical payloads valid', () => {
	const payload = samplePayload()
	expect(
		parseBackupFullManifest(signedManifest(payload)).payload.d1Sources,
	).toBe(undefined)
	const d1Sources = [
		{
			databaseId: '22222222-2222-4222-8222-222222222222',
			databaseName: 'kody',
			manifestKey: payload.d1ManifestKey,
			manifestSha256: 'a'.repeat(64),
		},
		{
			databaseId: '44444444-4444-4444-8444-444444444444',
			databaseName: 'kody-jobs',
			manifestKey:
				'daily/d1/44444444-4444-4444-8444-444444444444/2026-07-22/manifest.json',
			manifestSha256: 'b'.repeat(64),
		},
	]
	const withSources = signedManifest({ ...payload, d1Sources })
	expect(parseBackupFullManifest(withSources).payload.d1Sources).toEqual(
		d1Sources,
	)

	expect(() =>
		parseBackupFullManifest(signedManifest({ ...payload, d1Sources: [] })),
	).toThrow(/invalid versioned shape/)
	expect(() =>
		parseBackupFullManifest(
			signedManifest({
				...payload,
				d1Sources: [
					{
						...d1Sources[0]!,
						manifestKey: 'daily/d1/other/2026-07-22/manifest.json',
					},
				],
			}),
		),
	).toThrow(/invalid signed values/)
	expect(() =>
		parseBackupFullManifest({
			...withSources,
			payload: { ...withSources.payload, extra: true },
		}),
	).toThrow(/invalid versioned shape/)
})

test('full-manifest parse/sign/verify round-trip with Ed25519', async () => {
	const { privateKey, publicKey } = generateKeyPairSync('ed25519')
	const payload = samplePayload()
	const signature = signBytes(
		null,
		Buffer.from(canonicalBackupFullManifestPayload(payload)),
		privateKey,
	)
	const manifest = parseBackupFullManifest({
		schemaVersion: backupFullManifestSchemaVersion,
		payload,
		signature: {
			algorithm: backupFullManifestSignatureAlgorithm,
			keyId: payload.signing.keyId,
			value: signature.toString('base64'),
		},
	})
	const spki = publicKey.export({ format: 'der', type: 'spki' })
	const verifyingKey = await crypto.subtle.importKey(
		'spki',
		spki,
		backupFullManifestSignatureAlgorithm,
		false,
		['verify'],
	)
	expect(
		await crypto.subtle.verify(
			backupFullManifestSignatureAlgorithm,
			verifyingKey,
			signature,
			new TextEncoder().encode(
				canonicalBackupFullManifestPayload(manifest.payload),
			),
		),
	).toBe(true)
	expect(
		await crypto.subtle.verify(
			backupFullManifestSignatureAlgorithm,
			verifyingKey,
			signature,
			new TextEncoder().encode(
				canonicalBackupFullManifestPayload({
					...manifest.payload,
					buildCommit: 'tampered',
				}),
			),
		),
	).toBe(false)
})
