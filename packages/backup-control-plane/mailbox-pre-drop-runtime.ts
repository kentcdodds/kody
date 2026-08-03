import {
	assertMailboxPreDropSnapshotUnchanged,
	readMailboxPreDropSnapshot,
	upsertMailboxPreDropApproval,
	verifyMailboxPreDropBackup,
} from './mailbox-pre-drop-approval.ts'
import {
	mailboxPreDropRuntimePayload,
	parseMailboxPreDropBackupRequest,
} from './mailbox-pre-drop-policy.ts'
import { verifyMailboxPreDropR2Policy } from './mailbox-pre-drop-r2-policy.ts'
import { runBackupRuntime, type BackupRuntimeStep } from './backup-runtime.ts'
import { errorCode, safeLog } from './backup-policy.ts'
import {
	type BackupEnvironment,
	type MailboxPreDropApprovalReceipt,
} from './backup-types.ts'
import { type ApiOptions } from './d1-export-api.ts'

type MailboxPreDropRuntimeEvent = {
	instanceId: string
	payload: unknown
	timestamp: Date
}

type MailboxPreDropRuntimeOptions = {
	api?: ApiOptions
	downloadFetcher?: typeof fetch
	now?: () => Date
}

const queryStepConfig = {
	retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' },
	timeout: '2 minutes',
} as const

export async function runMailboxLegacyGraphPreDropBackup(
	env: BackupEnvironment,
	event: MailboxPreDropRuntimeEvent,
	step: BackupRuntimeStep,
	options: MailboxPreDropRuntimeOptions = {},
): Promise<MailboxPreDropApprovalReceipt> {
	const request = parseMailboxPreDropBackupRequest(
		event.payload,
		event.timestamp,
		event.instanceId,
	)
	const payload = mailboxPreDropRuntimePayload(env, request)
	try {
		const before = await step.do(
			'mailbox-pre-drop-preflight',
			queryStepConfig,
			async () => readMailboxPreDropSnapshot(env, options.api),
		)
		await step.do(
			'mailbox-pre-drop-verify-live-r2-policy',
			{
				retries: { limit: 0, delay: '1 second' },
				timeout: '1 minute',
			},
			async () => verifyMailboxPreDropR2Policy(env, payload),
		)
		await runBackupRuntime(
			env,
			{
				instanceId: event.instanceId,
				payload,
				timestamp: event.timestamp,
			},
			step,
			{
				api: options.api,
				downloadFetcher: options.downloadFetcher,
				payloadKind: 'mailbox-legacy-graph-pre-drop',
			},
		)
		const after = await step.do(
			'mailbox-pre-drop-postflight',
			queryStepConfig,
			async () => readMailboxPreDropSnapshot(env, options.api),
		)
		assertMailboxPreDropSnapshotUnchanged(before, after)
		const verified = await step.do(
			'mailbox-pre-drop-reread-and-verify',
			{
				retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' },
				timeout: '15 minutes',
			},
			async () => verifyMailboxPreDropBackup({ env, payload }),
		)
		const verifiedAt = await step.do('mailbox-pre-drop-verified-at', async () =>
			(options.now ?? (() => new Date()))().toISOString(),
		)
		const receipt = await step.do(
			'mailbox-pre-drop-atomic-approval',
			queryStepConfig,
			async () =>
				upsertMailboxPreDropApproval({
					env,
					payload,
					snapshot: after,
					manifest: verified.manifest,
					manifestSignatureSha256: verified.manifestSignatureSha256,
					verifiedAt,
					options: options.api,
				}),
		)
		safeLog({
			event: 'mailbox-pre-drop-backup-approved',
			status: 'success',
			instanceId: event.instanceId,
			objectKey: receipt.sqlObjectKey,
			manifestKey: receipt.manifestKey,
			bytes: receipt.sqlBytes,
			sha256: receipt.sqlSha256,
		})
		return receipt
	} catch (error) {
		safeLog({
			event: 'mailbox-pre-drop-backup-failure',
			status: 'failure',
			instanceId: event.instanceId,
			manifestKey: payload.manifestKey,
			errorCode: errorCode(error),
		})
		throw error
	}
}
