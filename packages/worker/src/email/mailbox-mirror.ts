import { isSystemEmailOwner } from './email-owner.ts'
import {
	mailboxNamespace,
	mailboxRpc,
	type MailboxEnv,
} from './mailbox-client.ts'
import {
	toMailboxAttachmentInput,
	toMailboxMessageInput,
	toMailboxThreadInput,
} from './mailbox-snapshots.ts'
import {
	type EmailAttachmentRecord,
	type EmailDeliveryStatus,
	type EmailMessageRecord,
	type EmailThreadRecord,
} from './types.ts'
import {
	type MailboxDeleteDeliveryEventInput,
	type MailboxDeleteMessageMetadataInput,
	type MailboxDeleteResult,
	type MailboxDeleteThreadIfEmptyInput,
	type MailboxDeliveryEventInput,
	type MailboxPartialMutationResult,
	type MailboxSetMessageClassificationInput,
	type MailboxTouchThreadInput,
	type MailboxUpdateMessageDeliveryInput,
} from './mailbox-types.ts'

/**
 * Best-effort D1 → Mailbox dual-write helpers.
 *
 * Never throw into D1 authority paths: catch/log with stable tags and return
 * structured `mirrored | stale | skipped | error` outcomes. `system:email`
 * stays in D1 only.
 *
 * Delivery-event snapshots should be loaded via
 * `getMailboxDeliveryEventMirrorInput` (mailbox-snapshot-repo) so callers do
 * not supply promoted D1 columns individually.
 */

export type MailboxMirrorEnv = MailboxEnv

export type MailboxMirrorSkipReason =
	| 'system-email'
	| 'mailbox-unconfigured'
	| 'missing-owner'

export type MailboxMirrorResult =
	| { status: 'mirrored' }
	| { status: 'stale' }
	| { status: 'skipped'; reason: MailboxMirrorSkipReason }
	| { status: 'error'; error: unknown }

function resolveMirrorOwner(
	ownerId: string | null | undefined,
): { ok: true; ownerId: string } | { ok: false; result: MailboxMirrorResult } {
	if (ownerId == null || ownerId.length === 0) {
		return { ok: false, result: { status: 'skipped', reason: 'missing-owner' } }
	}
	if (isSystemEmailOwner(ownerId)) {
		return {
			ok: false,
			result: { status: 'skipped', reason: 'system-email' },
		}
	}
	return { ok: true, ownerId }
}

function skipIfMailboxMissing(
	env: MailboxMirrorEnv,
): MailboxMirrorResult | null {
	if (!mailboxNamespace(env)) {
		return { status: 'skipped', reason: 'mailbox-unconfigured' }
	}
	return null
}

/** Map touch/update/classify: accepted/missing → mirrored; stale → stale. */
function outcomeFromPartialMutation(
	result: MailboxPartialMutationResult,
): MailboxMirrorResult {
	switch (result.status) {
		case 'accepted':
		case 'missing':
			return { status: 'mirrored' }
		case 'stale':
			return { status: 'stale' }
		default: {
			const exhaustive: never = result
			throw new Error(
				`Unhandled mailbox partial mutation status: ${JSON.stringify(exhaustive)}`,
			)
		}
	}
}

/** Map delete RPC: deleted/missing → mirrored; stale → stale. */
function outcomeFromDeleteResult(
	result: MailboxDeleteResult,
): MailboxMirrorResult {
	switch (result.status) {
		case 'deleted':
		case 'missing':
			return { status: 'mirrored' }
		case 'stale':
			return { status: 'stale' }
		default: {
			const exhaustive: never = result
			throw new Error(
				`Unhandled mailbox delete status: ${JSON.stringify(exhaustive)}`,
			)
		}
	}
}

function outcomeFromAccepted(accepted: boolean): MailboxMirrorResult {
	return accepted ? { status: 'mirrored' } : { status: 'stale' }
}

async function runMirror(
	tag: string,
	run: () => Promise<MailboxMirrorResult>,
): Promise<MailboxMirrorResult> {
	try {
		return await run()
	} catch (error) {
		console.warn(tag, error)
		return { status: 'error', error }
	}
}

/** Best-effort full message (+ optional thread/attachments) snapshot mirror. */
export async function mirrorMailboxMessageSnapshot(input: {
	env: MailboxMirrorEnv
	thread?: EmailThreadRecord | null
	message: EmailMessageRecord
	attachments?: Array<EmailAttachmentRecord>
}): Promise<MailboxMirrorResult> {
	const owner = resolveMirrorOwner(input.message.userId)
	if (!owner.ok) return owner.result
	const skippedMailbox = skipIfMailboxMissing(input.env)
	if (skippedMailbox) return skippedMailbox

	return runMirror('mailbox-mirror-message-failed', async () => {
		const result = await mailboxRpc({
			env: input.env,
			userId: owner.ownerId,
		}).mirrorMessage({
			ownerId: owner.ownerId,
			thread: input.thread ? toMailboxThreadInput(input.thread) : null,
			message: toMailboxMessageInput(input.message),
			attachments: input.attachments?.map(toMailboxAttachmentInput),
		})
		return outcomeFromAccepted(result.accepted)
	})
}

/**
 * Best-effort delivery-event snapshot mirror.
 *
 * Prefer loading `event` with `getMailboxDeliveryEventMirrorInput` so promoted
 * D1 columns and detail decoding stay cohesive. `event.updatedAt` must be the
 * canonical `sourceMutationAt` from that load (inserts: `created_at`).
 */
export async function mirrorMailboxDeliveryEventSnapshot(input: {
	env: MailboxMirrorEnv
	ownerId: string
	event: MailboxDeliveryEventInput
	latestDeliveryStatus?: {
		messageId: string
		deliveryStatus: EmailDeliveryStatus
		deliveryStatusAt: string
	} | null
}): Promise<MailboxMirrorResult> {
	const owner = resolveMirrorOwner(input.ownerId)
	if (!owner.ok) return owner.result
	const skippedMailbox = skipIfMailboxMissing(input.env)
	if (skippedMailbox) return skippedMailbox

	return runMirror('mailbox-mirror-delivery-event-failed', async () => {
		const result = await mailboxRpc({
			env: input.env,
			userId: owner.ownerId,
		}).upsertDeliveryEvent({
			ownerId: owner.ownerId,
			event: input.event,
			latestDeliveryStatus: input.latestDeliveryStatus,
		})
		return outcomeFromAccepted(result.accepted)
	})
}

/** Best-effort thread touch mirror. */
export async function mirrorMailboxTouchThread(
	input: MailboxTouchThreadInput & { env: MailboxMirrorEnv },
): Promise<MailboxMirrorResult> {
	const owner = resolveMirrorOwner(input.ownerId)
	if (!owner.ok) return owner.result
	const skippedMailbox = skipIfMailboxMissing(input.env)
	if (skippedMailbox) return skippedMailbox

	return runMirror('mailbox-mirror-touch-thread-failed', async () => {
		const { env: _env, ...rpcInput } = input
		const result = await mailboxRpc({
			env: input.env,
			userId: owner.ownerId,
		}).touchThread(rpcInput)
		return outcomeFromPartialMutation(result)
	})
}

/** Best-effort outbound delivery/processing update mirror. */
export async function mirrorMailboxUpdateMessageDelivery(
	input: MailboxUpdateMessageDeliveryInput & { env: MailboxMirrorEnv },
): Promise<MailboxMirrorResult> {
	const owner = resolveMirrorOwner(input.ownerId)
	if (!owner.ok) return owner.result
	const skippedMailbox = skipIfMailboxMissing(input.env)
	if (skippedMailbox) return skippedMailbox

	return runMirror(
		'mailbox-mirror-update-message-delivery-failed',
		async () => {
			const { env: _env, ...rpcInput } = input
			const result = await mailboxRpc({
				env: input.env,
				userId: owner.ownerId,
			}).updateMessageDelivery(rpcInput)
			return outcomeFromPartialMutation(result)
		},
	)
}

/** Best-effort inbound classification update mirror. */
export async function mirrorMailboxSetMessageClassification(
	input: MailboxSetMessageClassificationInput & { env: MailboxMirrorEnv },
): Promise<MailboxMirrorResult> {
	const owner = resolveMirrorOwner(input.ownerId)
	if (!owner.ok) return owner.result
	const skippedMailbox = skipIfMailboxMissing(input.env)
	if (skippedMailbox) return skippedMailbox

	return runMirror(
		'mailbox-mirror-set-message-classification-failed',
		async () => {
			const { env: _env, ...rpcInput } = input
			const result = await mailboxRpc({
				env: input.env,
				userId: owner.ownerId,
			}).setMessageClassification(rpcInput)
			return outcomeFromPartialMutation(result)
		},
	)
}

/** Best-effort metadata-only message delete mirror (no R2). */
export async function mirrorMailboxDeleteMessageMetadata(
	input: MailboxDeleteMessageMetadataInput & { env: MailboxMirrorEnv },
): Promise<MailboxMirrorResult> {
	const owner = resolveMirrorOwner(input.ownerId)
	if (!owner.ok) return owner.result
	const skippedMailbox = skipIfMailboxMissing(input.env)
	if (skippedMailbox) return skippedMailbox

	return runMirror(
		'mailbox-mirror-delete-message-metadata-failed',
		async () => {
			const { env: _env, ...rpcInput } = input
			const result = await mailboxRpc({
				env: input.env,
				userId: owner.ownerId,
			}).deleteMessageMetadata(rpcInput)
			return outcomeFromDeleteResult(result)
		},
	)
}

/** Best-effort delivery-event delete mirror. */
export async function mirrorMailboxDeleteDeliveryEvent(
	input: MailboxDeleteDeliveryEventInput & { env: MailboxMirrorEnv },
): Promise<MailboxMirrorResult> {
	const owner = resolveMirrorOwner(input.ownerId)
	if (!owner.ok) return owner.result
	const skippedMailbox = skipIfMailboxMissing(input.env)
	if (skippedMailbox) return skippedMailbox

	return runMirror('mailbox-mirror-delete-delivery-event-failed', async () => {
		const { env: _env, ...rpcInput } = input
		const result = await mailboxRpc({
			env: input.env,
			userId: owner.ownerId,
		}).deleteDeliveryEvent(rpcInput)
		return outcomeFromDeleteResult(result)
	})
}

/** Best-effort empty-thread cleanup mirror (D1 deleteEmptyEmailThreads parity). */
export async function mirrorMailboxDeleteThreadIfEmpty(
	input: MailboxDeleteThreadIfEmptyInput & { env: MailboxMirrorEnv },
): Promise<MailboxMirrorResult> {
	const owner = resolveMirrorOwner(input.ownerId)
	if (!owner.ok) return owner.result
	const skippedMailbox = skipIfMailboxMissing(input.env)
	if (skippedMailbox) return skippedMailbox

	return runMirror('mailbox-mirror-delete-thread-if-empty-failed', async () => {
		const { env: _env, ...rpcInput } = input
		const result = await mailboxRpc({
			env: input.env,
			userId: owner.ownerId,
		}).deleteThreadIfEmpty(rpcInput)
		return outcomeFromDeleteResult(result)
	})
}
