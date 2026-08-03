import {
	parseBackupManifest,
	serializeBackupManifest,
	type BackupManifest,
} from '@kody-internal/shared/backup-manifest.ts'

import { verifyStoredObjectMatches } from './immutable-storage.ts'
import { verifyBackupManifestSignature } from './manifest-signing.ts'
import { BackupError, objectKeyForPayload } from './backup-policy.ts'
import {
	type BackupEnvironment,
	type MailboxPreDropRuntimePayload,
} from './backup-types.ts'

function decodeBase64(value: string): ArrayBuffer {
	try {
		const binary = atob(value)
		const bytes = new Uint8Array(binary.length)
		for (let index = 0; index < binary.length; index += 1) {
			bytes[index] = binary.charCodeAt(index)
		}
		return bytes.buffer
	} catch {
		throw new BackupError(
			'mailbox-pre-drop-manifest-signature-invalid',
			'manifest signature is not valid base64',
		)
	}
}

function hex(buffer: ArrayBuffer): string {
	return [...new Uint8Array(buffer)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('')
}

async function signatureSha256(manifest: BackupManifest): Promise<string> {
	const signature = decodeBase64(manifest.signature.value)
	if (signature.byteLength !== 64) {
		throw new BackupError(
			'mailbox-pre-drop-manifest-signature-invalid',
			'manifest Ed25519 signature has an invalid length',
		)
	}
	return hex(await crypto.subtle.digest('SHA-256', signature))
}

export async function verifyMailboxPreDropBackup(input: {
	env: BackupEnvironment
	payload: MailboxPreDropRuntimePayload
}): Promise<{
	manifest: BackupManifest
	manifestSignatureSha256: string
}> {
	const manifestObject = await input.env.BACKUP_BUCKET.get(
		input.payload.manifestKey,
	)
	if (manifestObject === null) {
		throw new BackupError(
			'mailbox-pre-drop-manifest-missing',
			'pre-drop backup manifest is missing',
		)
	}
	let manifest: BackupManifest
	const manifestText = await manifestObject.text()
	try {
		manifest = parseBackupManifest(JSON.parse(manifestText))
	} catch {
		throw new BackupError(
			'mailbox-pre-drop-manifest-invalid',
			'pre-drop backup manifest is invalid',
		)
	}
	if (manifestText !== serializeBackupManifest(manifest)) {
		throw new BackupError(
			'mailbox-pre-drop-manifest-noncanonical',
			'pre-drop backup manifest bytes are not canonical',
		)
	}
	if (
		manifest.payload.source.accountId !== input.env.SOURCE_ACCOUNT_ID ||
		manifest.payload.source.databaseId !== input.env.SOURCE_DATABASE_ID ||
		manifest.payload.source.databaseName !== input.env.SOURCE_DATABASE_NAME ||
		manifest.payload.export.scheduledAt !== input.payload.requestedAt ||
		manifest.payload.buildCommit !== input.env.BUILD_COMMIT ||
		manifest.payload.retentionTier !== 'daily' ||
		manifest.payload.restoreBaseline.id !==
			input.env.TRUSTED_RESTORE_BASELINE_ID ||
		manifest.payload.restoreBaseline.sha256 !==
			input.env.TRUSTED_RESTORE_BASELINE_SHA256 ||
		manifest.payload.signing.keyId !==
			input.env.BACKUP_MANIFEST_SIGNING_KEY_ID ||
		manifest.payload.sql.objectKey !==
			objectKeyForPayload(input.payload, manifest.payload.export.bookmark)
	) {
		throw new BackupError(
			'mailbox-pre-drop-manifest-provenance-mismatch',
			'pre-drop backup manifest provenance does not match the approved request',
		)
	}
	if (!(await verifyBackupManifestSignature(input.env, manifest))) {
		throw new BackupError(
			'mailbox-pre-drop-manifest-signature-invalid',
			'pre-drop backup manifest signature verification failed',
		)
	}
	await verifyStoredObjectMatches(
		input.env.BACKUP_BUCKET,
		manifest.payload.sql.objectKey,
		{
			bytes: manifest.payload.sql.bytes,
			sha256: manifest.payload.sql.sha256,
			r2Etag: manifest.payload.sql.r2Etag,
			alreadyExisted: true,
		},
	)
	return {
		manifest,
		manifestSignatureSha256: await signatureSha256(manifest),
	}
}
