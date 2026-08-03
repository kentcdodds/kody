import { isBucketLockPolicyPutError } from './immutable-storage.ts'
import { BackupError } from './backup-policy.ts'
import {
	type BackupEnvironment,
	type MailboxPreDropRuntimePayload,
} from './backup-types.ts'

const lockProbeBody = 'mailbox-pre-drop-r2-lock-preflight-v1'
const lockProbeOverwriteBody = 'mailbox-pre-drop-r2-lock-overwrite-v1'

export async function verifyMailboxPreDropR2Policy(
	env: BackupEnvironment,
	payload: MailboxPreDropRuntimePayload,
): Promise<void> {
	const key = `${payload.objectPrefix}/r2-policy-destructive-probe`
	await env.BACKUP_BUCKET.put(key, lockProbeBody, {
		onlyIf: { etagDoesNotMatch: '*' },
		httpMetadata: { contentType: 'text/plain' },
	}).catch((error: unknown) => {
		if (isBucketLockPolicyPutError(error)) return null
		throw error
	})
	if ((await env.BACKUP_BUCKET.head(key)) === null) {
		throw new BackupError(
			'mailbox-pre-drop-r2-policy-unverified',
			'adhoc R2 policy probe could not be read after creation',
		)
	}
	let overwriteWasLocked = false
	await env.BACKUP_BUCKET.put(key, lockProbeOverwriteBody, {
		httpMetadata: { contentType: 'text/plain' },
	})
		.then(() => undefined)
		.catch((error: unknown) => {
			if (!isBucketLockPolicyPutError(error)) throw error
			overwriteWasLocked = true
		})
	if (!overwriteWasLocked) {
		throw new BackupError(
			'mailbox-pre-drop-r2-policy-unverified',
			'adhoc R2 policy does not block destructive overwrite; do not export or approve until the 35-day lock and lifecycle are verified live',
		)
	}
}
