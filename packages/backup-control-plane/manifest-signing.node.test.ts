import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'

import {
	canonicalBackupManifestPayload,
	type BackupManifestPayload,
} from '@kody-internal/shared/backup-manifest.ts'
import { test } from 'vitest'

import { signBackupManifest } from './manifest-signing.ts'
import { BackupError } from './backup-policy.ts'
import {
	encodeNodeBytesAsBase64,
	environment,
} from './backup-control-plane-test-support.ts'

function unsignedPayload(): Omit<
	BackupManifestPayload,
	'schemaVersion' | 'restoreBaseline' | 'signing'
> {
	return {
		source: {
			accountId: 'a'.repeat(32),
			databaseId: '11111111-1111-4111-8111-111111111111',
			databaseName: 'production-db',
		},
		export: {
			bookmark: 'bookmark-1',
			scheduledAt: '2026-07-22T02:15:00.000Z',
			startedAt: '2026-07-22T02:15:01.000Z',
			completedAt: '2026-07-22T02:16:00.000Z',
		},
		sql: {
			objectKey: 'daily/d1/production/backup.sql',
			bytes: 5,
			sha256: '1'.repeat(64),
			r2Etag: 'etag-1',
		},
		buildCommit: 'abc123',
		retentionTier: 'daily',
	}
}

test('Worker-compatible Ed25519 manifest signatures reject tampering and wrong keys', async () => {
	const signingKeys = generateKeyPairSync('ed25519')
	const wrongKeys = generateKeyPairSync('ed25519')
	const env = environment()
	env.BACKUP_MANIFEST_SIGNING_PRIVATE_KEY_PKCS8_BASE64 =
		encodeNodeBytesAsBase64(
			signingKeys.privateKey.export({ format: 'der', type: 'pkcs8' }),
		)
	const manifest = await signBackupManifest(env, unsignedPayload())
	const payloadBytes = new TextEncoder().encode(
		canonicalBackupManifestPayload(manifest.payload),
	)
	const signature = Buffer.from(manifest.signature.value, 'base64')
	const tamperedPayloadBytes = new TextEncoder().encode(
		canonicalBackupManifestPayload({
			...manifest.payload,
			sql: { ...manifest.payload.sql, sha256: '2'.repeat(64) },
		}),
	)
	const tamperedSignature = Buffer.from(signature)
	tamperedSignature[0] = (tamperedSignature[0] ?? 0) ^ 1
	const cases: Array<
		[
			typeof signingKeys.publicKey,
			Uint8Array<ArrayBuffer>,
			Uint8Array<ArrayBuffer>,
			boolean,
		]
	> = [
		[signingKeys.publicKey, signature, payloadBytes, true],
		[signingKeys.publicKey, signature, tamperedPayloadBytes, false],
		[signingKeys.publicKey, tamperedSignature, payloadBytes, false],
		[wrongKeys.publicKey, signature, payloadBytes, false],
	]
	for (const [publicKey, candidateSignature, bytes, valid] of cases) {
		const key = await crypto.subtle.importKey(
			'spki',
			publicKey.export({ format: 'der', type: 'spki' }),
			'Ed25519',
			false,
			['verify'],
		)
		assert.equal(
			await crypto.subtle.verify('Ed25519', key, candidateSignature, bytes),
			valid,
		)
	}
})

test('invalid PKCS#8 signing material fails without exposing key material', async () => {
	const env = environment()
	env.BACKUP_MANIFEST_SIGNING_PRIVATE_KEY_PKCS8_BASE64 =
		Buffer.from('not-pkcs8').toString('base64')
	await assert.rejects(
		signBackupManifest(env, unsignedPayload()),
		(error: unknown) =>
			error instanceof BackupError &&
			error.code === 'manifest-signing-failed' &&
			!error.message.includes(
				env.BACKUP_MANIFEST_SIGNING_PRIVATE_KEY_PKCS8_BASE64,
			),
	)
})
