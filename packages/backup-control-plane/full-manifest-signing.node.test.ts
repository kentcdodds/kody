import assert from 'node:assert/strict'

import { test } from 'vitest'

import {
	signBackupFullManifest,
	verifyBackupFullManifestSignature,
} from './full-manifest-signing.ts'
import { environment } from './backup-control-plane-test-support.ts'

test('full manifest sign/verify round-trip', async () => {
	const env = environment()
	const manifest = await signBackupFullManifest(env, {
		day: '2026-07-22',
		d1ManifestKey: `daily/d1/${env.SOURCE_DATABASE_ID}/2026-07-22/manifest.json`,
		d1ManifestSha256: 'a'.repeat(64),
		storageIndex: {
			objectKey: 'daily/full/2026-07-22/storage-index.json',
			bytes: 10,
			sha256: 'b'.repeat(64),
		},
		r2Indexes: {
			'email-blobs': {
				objectKey: 'daily/full/2026-07-22/r2-index/email-blobs.ndjson',
				bytes: 4,
				sha256: 'c'.repeat(64),
			},
		},
		artifactsIndex: {
			objectKey: 'daily/full/2026-07-22/artifacts-index.json',
			bytes: 3,
			sha256: 'd'.repeat(64),
		},
		sealedAt: '2026-07-22T12:00:00.000Z',
		buildCommit: 'abc123',
	})
	assert.equal(await verifyBackupFullManifestSignature(env, manifest), true)
	manifest.payload.buildCommit = 'tampered'
	assert.equal(await verifyBackupFullManifestSignature(env, manifest), false)
})
