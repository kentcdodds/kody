import { isSystemEmailOwner } from './email-owner.ts'
import {
	mailboxNamespace,
	mailboxRpc,
	type MailboxEnv,
} from './mailbox-client.ts'
import {
	recordMailboxParityEvent,
	type MailboxMirrorOperation,
	type MailboxMirrorOutcome,
	type MailboxParityEnv,
} from './mailbox-parity-events.ts'
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
 * structured outcomes (`mirrored | stale | missing | timeout | skipped |
 * error`). `system:email` stays in D1 only.
 *
 * Every awaited DO RPC is bounded by {@link mailboxMirrorRpcTimeoutMs}. Partial
 * mutation `missing` stays distinct from `mirrored`; delete `missing` maps to
 * `mirrored` because desired absence is achieved. Outcomes are recorded via
 * `recordMailboxParityEvent` when a user id is known.
 *
 * Delivery-event snapshots should be loaded via
 * `getMailboxDeliveryEventMirrorInput` (mailbox-snapshot-repo) so callers do
 * not supply promoted D1 columns individually.
 */

/** Bound every awaited Mailbox DO mirror RPC (~1s). */
export const mailboxMirrorRpcTimeoutMs = 1_000

export type MailboxMirrorEnv = MailboxEnv & MailboxParityEnv

export type MailboxMirrorSkipReason =
	| 'system-email'
	| 'mailbox-unconfigured'
	| 'missing-owner'

export type MailboxMirrorResult =
	| { status: 'mirrored' }
	| { status: 'stale' }
	| { status: 'missing' }
	| { status: 'timeout' }
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

function mirrorOutcome(result: MailboxMirrorResult): MailboxMirrorOutcome {
	switch (result.status) {
		case 'mirrored':
		case 'stale':
		case 'missing':
		case 'timeout':
		case 'error':
			return result.status
		case 'skipped':
			return 'skipped'
		default: {
			const exhaustive: never = result
			throw new Error(
				`Unhandled mailbox mirror result: ${JSON.stringify(exhaustive)}`,
			)
		}
	}
}

function recordMirrorOutcome(
	env: MailboxMirrorEnv,
	userId: string | null | undefined,
	operation: MailboxMirrorOperation,
	result: MailboxMirrorResult,
): void {
	if (userId == null || userId.length === 0) return
	recordMailboxParityEvent(env, {
		userId,
		category: 'mirror',
		operation,
		outcome: mirrorOutcome(result),
	})
}

/** Map touch/update/classify: accepted → mirrored; missing/stale stay distinct. */
function outcomeFromPartialMutation(
	result: MailboxPartialMutationResult,
): MailboxMirrorResult {
	switch (result.status) {
		case 'accepted':
			return { status: 'mirrored' }
		case 'missing':
			return { status: 'missing' }
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

/**
 * Race a DO RPC against {@link mailboxMirrorRpcTimeoutMs}.
 * The settled wrapper ensures a late rejection cannot become unhandled.
 */
export async function awaitMailboxMirrorRpc<T>(
	rpc: Promise<T>,
	timeoutMs: number = mailboxMirrorRpcTimeoutMs,
): Promise<{ ok: true; value: T } | { ok: false; timedOut: true }> {
	const settled = rpc.then(
		(value) => ({ kind: 'fulfilled' as const, value }),
		(error: unknown) => ({ kind: 'rejected' as const, error }),
	)
	let timeoutId: ReturnType<typeof setTimeout> | undefined
	try {
		const raced = await Promise.race([
			settled,
			new Promise<{ kind: 'timeout' }>((resolve) => {
				timeoutId = setTimeout(() => {
					resolve({ kind: 'timeout' })
				}, timeoutMs)
			}),
		])
		if (raced.kind === 'timeout') {
			return { ok: false, timedOut: true }
		}
		if (raced.kind === 'rejected') {
			throw raced.error
		}
		return { ok: true, value: raced.value }
	} finally {
		if (timeoutId !== undefined) clearTimeout(timeoutId)
	}
}

async function runMirror(input: {
	tag: string
	env: MailboxMirrorEnv
	userId: string | null | undefined
	operation: MailboxMirrorOperation
	run: () => Promise<MailboxMirrorResult>
}): Promise<MailboxMirrorResult> {
	let result: MailboxMirrorResult
	try {
		result = await input.run()
	} catch (error) {
		console.warn(input.tag, error)
		result = { status: 'error', error }
	}
	recordMirrorOutcome(input.env, input.userId, input.operation, result)
	return result
}

function finishEarly(input: {
	env: MailboxMirrorEnv
	userId: string | null | undefined
	operation: MailboxMirrorOperation
	result: MailboxMirrorResult
}): MailboxMirrorResult {
	recordMirrorOutcome(input.env, input.userId, input.operation, input.result)
	return input.result
}

/** Best-effort full message (+ optional thread/attachments) snapshot mirror. */
export async function mirrorMailboxMessageSnapshot(input: {
	env: MailboxMirrorEnv
	thread?: EmailThreadRecord | null
	message: EmailMessageRecord
	attachments?: Array<EmailAttachmentRecord>
}): Promise<MailboxMirrorResult> {
	const operation = 'mirror_message' as const
	const owner = resolveMirrorOwner(input.message.userId)
	if (!owner.ok) {
		return finishEarly({
			env: input.env,
			userId: input.message.userId,
			operation,
			result: owner.result,
		})
	}
	const skippedMailbox = skipIfMailboxMissing(input.env)
	if (skippedMailbox) {
		return finishEarly({
			env: input.env,
			userId: owner.ownerId,
			operation,
			result: skippedMailbox,
		})
	}

	return runMirror({
		tag: 'mailbox-mirror-message-failed',
		env: input.env,
		userId: owner.ownerId,
		operation,
		run: async () => {
			const raced = await awaitMailboxMirrorRpc(
				mailboxRpc({
					env: input.env,
					userId: owner.ownerId,
				}).mirrorMessage({
					ownerId: owner.ownerId,
					thread: input.thread ? toMailboxThreadInput(input.thread) : null,
					message: toMailboxMessageInput(input.message),
					attachments: input.attachments?.map(toMailboxAttachmentInput),
				}),
			)
			if (!raced.ok) return { status: 'timeout' }
			return outcomeFromAccepted(raced.value.accepted)
		},
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
	const operation = 'upsert_delivery_event' as const
	const owner = resolveMirrorOwner(input.ownerId)
	if (!owner.ok) {
		return finishEarly({
			env: input.env,
			userId: input.ownerId,
			operation,
			result: owner.result,
		})
	}
	const skippedMailbox = skipIfMailboxMissing(input.env)
	if (skippedMailbox) {
		return finishEarly({
			env: input.env,
			userId: owner.ownerId,
			operation,
			result: skippedMailbox,
		})
	}

	return runMirror({
		tag: 'mailbox-mirror-delivery-event-failed',
		env: input.env,
		userId: owner.ownerId,
		operation,
		run: async () => {
			const raced = await awaitMailboxMirrorRpc(
				mailboxRpc({
					env: input.env,
					userId: owner.ownerId,
				}).upsertDeliveryEvent({
					ownerId: owner.ownerId,
					event: input.event,
					latestDeliveryStatus: input.latestDeliveryStatus,
				}),
			)
			if (!raced.ok) return { status: 'timeout' }
			return outcomeFromAccepted(raced.value.accepted)
		},
	})
}

/** Best-effort thread touch mirror. */
export async function mirrorMailboxTouchThread(
	input: MailboxTouchThreadInput & { env: MailboxMirrorEnv },
): Promise<MailboxMirrorResult> {
	const operation = 'touch_thread' as const
	const owner = resolveMirrorOwner(input.ownerId)
	if (!owner.ok) {
		return finishEarly({
			env: input.env,
			userId: input.ownerId,
			operation,
			result: owner.result,
		})
	}
	const skippedMailbox = skipIfMailboxMissing(input.env)
	if (skippedMailbox) {
		return finishEarly({
			env: input.env,
			userId: owner.ownerId,
			operation,
			result: skippedMailbox,
		})
	}

	return runMirror({
		tag: 'mailbox-mirror-touch-thread-failed',
		env: input.env,
		userId: owner.ownerId,
		operation,
		run: async () => {
			const { env: _env, ...rpcInput } = input
			const raced = await awaitMailboxMirrorRpc(
				mailboxRpc({
					env: input.env,
					userId: owner.ownerId,
				}).touchThread(rpcInput),
			)
			if (!raced.ok) return { status: 'timeout' }
			return outcomeFromPartialMutation(raced.value)
		},
	})
}

/** Best-effort outbound delivery/processing update mirror. */
export async function mirrorMailboxUpdateMessageDelivery(
	input: MailboxUpdateMessageDeliveryInput & { env: MailboxMirrorEnv },
): Promise<MailboxMirrorResult> {
	const operation = 'update_message_delivery' as const
	const owner = resolveMirrorOwner(input.ownerId)
	if (!owner.ok) {
		return finishEarly({
			env: input.env,
			userId: input.ownerId,
			operation,
			result: owner.result,
		})
	}
	const skippedMailbox = skipIfMailboxMissing(input.env)
	if (skippedMailbox) {
		return finishEarly({
			env: input.env,
			userId: owner.ownerId,
			operation,
			result: skippedMailbox,
		})
	}

	return runMirror({
		tag: 'mailbox-mirror-update-message-delivery-failed',
		env: input.env,
		userId: owner.ownerId,
		operation,
		run: async () => {
			const { env: _env, ...rpcInput } = input
			const raced = await awaitMailboxMirrorRpc(
				mailboxRpc({
					env: input.env,
					userId: owner.ownerId,
				}).updateMessageDelivery(rpcInput),
			)
			if (!raced.ok) return { status: 'timeout' }
			return outcomeFromPartialMutation(raced.value)
		},
	})
}

/** Best-effort inbound classification update mirror. */
export async function mirrorMailboxSetMessageClassification(
	input: MailboxSetMessageClassificationInput & { env: MailboxMirrorEnv },
): Promise<MailboxMirrorResult> {
	const operation = 'set_message_classification' as const
	const owner = resolveMirrorOwner(input.ownerId)
	if (!owner.ok) {
		return finishEarly({
			env: input.env,
			userId: input.ownerId,
			operation,
			result: owner.result,
		})
	}
	const skippedMailbox = skipIfMailboxMissing(input.env)
	if (skippedMailbox) {
		return finishEarly({
			env: input.env,
			userId: owner.ownerId,
			operation,
			result: skippedMailbox,
		})
	}

	return runMirror({
		tag: 'mailbox-mirror-set-message-classification-failed',
		env: input.env,
		userId: owner.ownerId,
		operation,
		run: async () => {
			const { env: _env, ...rpcInput } = input
			const raced = await awaitMailboxMirrorRpc(
				mailboxRpc({
					env: input.env,
					userId: owner.ownerId,
				}).setMessageClassification(rpcInput),
			)
			if (!raced.ok) return { status: 'timeout' }
			return outcomeFromPartialMutation(raced.value)
		},
	})
}

/** Best-effort metadata-only message delete mirror (no R2). */
export async function mirrorMailboxDeleteMessageMetadata(
	input: MailboxDeleteMessageMetadataInput & { env: MailboxMirrorEnv },
): Promise<MailboxMirrorResult> {
	const operation = 'delete_message_metadata' as const
	const owner = resolveMirrorOwner(input.ownerId)
	if (!owner.ok) {
		return finishEarly({
			env: input.env,
			userId: input.ownerId,
			operation,
			result: owner.result,
		})
	}
	const skippedMailbox = skipIfMailboxMissing(input.env)
	if (skippedMailbox) {
		return finishEarly({
			env: input.env,
			userId: owner.ownerId,
			operation,
			result: skippedMailbox,
		})
	}

	return runMirror({
		tag: 'mailbox-mirror-delete-message-metadata-failed',
		env: input.env,
		userId: owner.ownerId,
		operation,
		run: async () => {
			const { env: _env, ...rpcInput } = input
			const raced = await awaitMailboxMirrorRpc(
				mailboxRpc({
					env: input.env,
					userId: owner.ownerId,
				}).deleteMessageMetadata(rpcInput),
			)
			if (!raced.ok) return { status: 'timeout' }
			return outcomeFromDeleteResult(raced.value)
		},
	})
}

/** Best-effort delivery-event delete mirror. */
export async function mirrorMailboxDeleteDeliveryEvent(
	input: MailboxDeleteDeliveryEventInput & { env: MailboxMirrorEnv },
): Promise<MailboxMirrorResult> {
	const operation = 'delete_delivery_event' as const
	const owner = resolveMirrorOwner(input.ownerId)
	if (!owner.ok) {
		return finishEarly({
			env: input.env,
			userId: input.ownerId,
			operation,
			result: owner.result,
		})
	}
	const skippedMailbox = skipIfMailboxMissing(input.env)
	if (skippedMailbox) {
		return finishEarly({
			env: input.env,
			userId: owner.ownerId,
			operation,
			result: skippedMailbox,
		})
	}

	return runMirror({
		tag: 'mailbox-mirror-delete-delivery-event-failed',
		env: input.env,
		userId: owner.ownerId,
		operation,
		run: async () => {
			const { env: _env, ...rpcInput } = input
			const raced = await awaitMailboxMirrorRpc(
				mailboxRpc({
					env: input.env,
					userId: owner.ownerId,
				}).deleteDeliveryEvent(rpcInput),
			)
			if (!raced.ok) return { status: 'timeout' }
			return outcomeFromDeleteResult(raced.value)
		},
	})
}

/** Best-effort empty-thread cleanup mirror (D1 deleteEmptyEmailThreads parity). */
export async function mirrorMailboxDeleteThreadIfEmpty(
	input: MailboxDeleteThreadIfEmptyInput & { env: MailboxMirrorEnv },
): Promise<MailboxMirrorResult> {
	const operation = 'delete_thread_if_empty' as const
	const owner = resolveMirrorOwner(input.ownerId)
	if (!owner.ok) {
		return finishEarly({
			env: input.env,
			userId: input.ownerId,
			operation,
			result: owner.result,
		})
	}
	const skippedMailbox = skipIfMailboxMissing(input.env)
	if (skippedMailbox) {
		return finishEarly({
			env: input.env,
			userId: owner.ownerId,
			operation,
			result: skippedMailbox,
		})
	}

	return runMirror({
		tag: 'mailbox-mirror-delete-thread-if-empty-failed',
		env: input.env,
		userId: owner.ownerId,
		operation,
		run: async () => {
			const { env: _env, ...rpcInput } = input
			const raced = await awaitMailboxMirrorRpc(
				mailboxRpc({
					env: input.env,
					userId: owner.ownerId,
				}).deleteThreadIfEmpty(rpcInput),
			)
			if (!raced.ok) return { status: 'timeout' }
			return outcomeFromDeleteResult(raced.value)
		},
	})
}
