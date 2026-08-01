import { truncateToUtf8Bytes } from '@kody-internal/shared/backup-restore-safety.ts'
import { mailboxRpc } from './mailbox-client.ts'
import { type MailboxLiveMirrorEnv } from './mailbox-live-mirror.ts'
import {
	awaitMailboxMirrorRpc,
	mailboxMirrorRpcTimeoutMs,
} from './mailbox-mirror.ts'
import {
	recordMailboxParityEvent,
	type MailboxParityOperation,
} from './mailbox-parity-events.ts'
import {
	backfillEventsForUser,
	backfillMessagesForUser,
	mailboxParityContentPageSize,
	mailboxParityEventPageSize,
	mailboxParityMessagePageSize,
	mirrorMailboxParityDeliveryEventFromD1,
	replayContentUpdatesForUser,
} from './mailbox-parity-phases.ts'
import {
	countD1MailboxParity,
	isUserDeleting,
	listEventBackfillPage,
	listUsersForMailboxParity,
	loadUserParityState,
	persistUserParityProgress,
	rotateCheckedAt,
	type MailboxParityUserState,
} from './mailbox-parity-repo.ts'
import { type MailboxCountResult } from './mailbox-types.ts'

/**
 * Bounded hourly Mailbox backfill + count-parity reconciler.
 *
 * Discovers a small oldest-first page of non-deleting D1 mail owners (no DO
 * enumeration), mirrors message graphs then every owner delivery event through
 * existing live-mirror helpers (repairing graph truncation), durably
 * keyset-replays messages updated after the content watermark, then compares
 * owner-scoped D1 counts with `countMailbox`. D1 remains mail authority; this
 * lane never mutates email_* rows and does not flip read authority.
 */

export const mailboxParityUserBatchSize = 8
export const mailboxParityTimeBudgetMs = 10_000
export const mailboxParityLastErrorMaxBytes = 512

export {
	mailboxParityContentPageSize,
	mailboxParityEventPageSize,
	mailboxParityMessagePageSize,
	mirrorMailboxParityDeliveryEventFromD1,
}

export type MailboxParityReconcileEnv = MailboxLiveMirrorEnv & {
	APP_DB: D1Database
}

export type MailboxParityReconcileMetrics = {
	scanned: number
	backfilled: number
	compared: number
	matched: number
	mismatched: number
	failed: number
}

export {
	countD1MailboxParity,
	listEventBackfillPage,
	listUsersForMailboxParity,
}

function safeParityErrorText(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error)
	let cleaned = ''
	for (const character of raw) {
		const code = character.codePointAt(0) ?? 0
		cleaned += code < 0x20 || code === 0x7f ? ' ' : character
	}
	cleaned = cleaned.trim()
	return truncateToUtf8Bytes(
		cleaned.length > 0 ? cleaned : 'unknown error',
		mailboxParityLastErrorMaxBytes,
	)
}

async function purgeMailboxBestEffort(input: {
	env: MailboxParityReconcileEnv
	userId: string
}) {
	try {
		await awaitMailboxMirrorRpc(
			mailboxRpc({ env: input.env, userId: input.userId }).purge(),
			mailboxMirrorRpcTimeoutMs,
		)
	} catch (error) {
		console.warn('mailbox-parity-purge-on-delete-failed', input.userId, error)
	}
}

function emitCountComparisons(input: {
	env: MailboxParityReconcileEnv
	userId: string
	d1: MailboxCountResult
	mailbox: MailboxCountResult
	timestamp: string
}): { matched: boolean } {
	const comparisons: Array<{
		operation: MailboxParityOperation
		d1Count: number
		doCount: number
	}> = [
		{
			operation: 'compare_threads',
			d1Count: input.d1.threads,
			doCount: input.mailbox.threads,
		},
		{
			operation: 'compare_messages',
			d1Count: input.d1.messages,
			doCount: input.mailbox.messages,
		},
		{
			operation: 'compare_attachments',
			d1Count: input.d1.attachments,
			doCount: input.mailbox.attachments,
		},
		{
			operation: 'compare_delivery_events',
			d1Count: input.d1.deliveryEvents,
			doCount: input.mailbox.deliveryEvents,
		},
	]
	let matched = true
	for (const comparison of comparisons) {
		const outcome =
			comparison.d1Count === comparison.doCount ? 'match' : 'mismatch'
		if (outcome === 'mismatch') matched = false
		recordMailboxParityEvent(input.env, {
			userId: input.userId,
			category: 'parity',
			operation: comparison.operation,
			outcome,
			d1Count: comparison.d1Count,
			doCount: comparison.doCount,
			timestamp: input.timestamp,
		})
	}
	return { matched }
}

async function ensureContentWatermarkBaseline(input: {
	db: D1Database
	state: MailboxParityUserState
	nowIso: string
}): Promise<MailboxParityUserState> {
	if (input.state.contentWatermarkAt != null) return input.state
	const state = {
		...input.state,
		contentWatermarkAt: input.nowIso,
	}
	await persistUserParityProgress({
		db: input.db,
		userId: state.userId,
		nowIso: input.nowIso,
		matchingSince: state.matchingSince,
		mismatchCount: state.mismatchCount,
		contentWatermarkAt: state.contentWatermarkAt,
		contentReplayUpperAt: state.contentReplayUpperAt,
		contentReplayCursor: state.contentReplayCursor,
		messageCursor: state.messageCursor,
		messagesCompletedAt: state.messagesCompletedAt,
		eventCursor: state.eventCursor,
		eventsCompletedAt: state.eventsCompletedAt,
		lastError: null,
	})
	return state
}

async function compareParityForUser(input: {
	env: MailboxParityReconcileEnv
	state: MailboxParityUserState
	nowIso: string
}): Promise<{
	state: MailboxParityUserState
	matched: boolean
}> {
	const d1 = await countD1MailboxParity({
		db: input.env.APP_DB,
		userId: input.state.userId,
	})
	const raced = await awaitMailboxMirrorRpc(
		mailboxRpc({ env: input.env, userId: input.state.userId }).countMailbox(),
		mailboxMirrorRpcTimeoutMs,
	)
	if (!raced.ok) {
		throw new Error('Mailbox countMailbox timed out')
	}
	const mailbox = raced.value
	const { matched } = emitCountComparisons({
		env: input.env,
		userId: input.state.userId,
		d1,
		mailbox,
		timestamp: input.nowIso,
	})
	if (matched) {
		return {
			state: {
				...input.state,
				matchingSince: input.state.matchingSince ?? input.nowIso,
				mismatchCount: 0,
			},
			matched: true,
		}
	}
	// Full historical rescan: clear creation cursors + completion markers.
	// Preserve content watermark; drop any in-flight replay window; clear soak.
	return {
		state: {
			...input.state,
			matchingSince: null,
			mismatchCount: input.state.mismatchCount + 1,
			messageCursor: null,
			messagesCompletedAt: null,
			eventCursor: null,
			eventsCompletedAt: null,
			contentReplayUpperAt: null,
			contentReplayCursor: null,
		},
		matched: false,
	}
}

async function reconcileOneUser(input: {
	env: MailboxParityReconcileEnv
	userId: string
	nowIso: string
	deadlineMs: number
}): Promise<{
	backfilled: number
	compared: boolean
	matched: boolean
	mismatched: boolean
	failed: boolean
	budgetExhausted: boolean
}> {
	const loaded = await loadUserParityState({
		db: input.env.APP_DB,
		userId: input.userId,
	})
	if (!loaded) {
		return {
			backfilled: 0,
			compared: false,
			matched: false,
			mismatched: false,
			failed: false,
			budgetExhausted: false,
		}
	}

	let state = loaded
	let backfilled = 0
	let creationBackfilled = 0

	const isDeleting = () =>
		isUserDeleting({ db: input.env.APP_DB, userId: state.userId })

	const stopForDeletion = async () => {
		await purgeMailboxBestEffort({
			env: input.env,
			userId: state.userId,
		})
		return {
			backfilled,
			compared: false,
			matched: false,
			mismatched: false,
			failed: false,
			budgetExhausted: false,
		}
	}

	const persistProgress = async (inputPersist: {
		matchingSince: string | null
		lastError: string | null
	}) => {
		const { wrote } = await persistUserParityProgress({
			db: input.env.APP_DB,
			userId: state.userId,
			nowIso: input.nowIso,
			matchingSince: inputPersist.matchingSince,
			mismatchCount: state.mismatchCount,
			contentWatermarkAt: state.contentWatermarkAt,
			contentReplayUpperAt: state.contentReplayUpperAt,
			contentReplayCursor: state.contentReplayCursor,
			messageCursor: state.messageCursor,
			messagesCompletedAt: state.messagesCompletedAt,
			eventCursor: state.eventCursor,
			eventsCompletedAt: state.eventsCompletedAt,
			lastError: inputPersist.lastError,
		})
		return wrote
	}

	if (await isDeleting()) {
		return stopForDeletion()
	}

	// Baseline before scanning so mid-backfill updates stay inside the replay window.
	state = await ensureContentWatermarkBaseline({
		db: input.env.APP_DB,
		state,
		nowIso: input.nowIso,
	})
	if (await isDeleting()) {
		return stopForDeletion()
	}

	const messagePass = await backfillMessagesForUser({
		env: input.env,
		state,
		deadlineMs: input.deadlineMs,
		isDeleting,
	})
	state = messagePass.state
	creationBackfilled += messagePass.backfilled
	backfilled += messagePass.backfilled
	if (messagePass.deletionStarted) {
		return stopForDeletion()
	}
	if (messagePass.retryableFailure) {
		await persistProgress({
			matchingSince: null,
			lastError: messagePass.blockedReason
				? `message backfill ${messagePass.blockedReason}`
				: 'message backfill mirror error or timeout',
		})
		console.warn(
			'mailbox-parity-message-backfill-retryable',
			state.userId,
			messagePass.blockedReason ?? 'error-or-timeout',
		)
		return {
			backfilled,
			compared: false,
			matched: false,
			mismatched: false,
			failed: true,
			budgetExhausted: false,
		}
	}
	if (messagePass.budgetExhausted) {
		await persistProgress({ matchingSince: null, lastError: null })
		return {
			backfilled,
			compared: false,
			matched: false,
			mismatched: false,
			failed: false,
			budgetExhausted: true,
		}
	}

	const eventPass = await backfillEventsForUser({
		env: input.env,
		state,
		deadlineMs: input.deadlineMs,
		isDeleting,
	})
	state = eventPass.state
	creationBackfilled += eventPass.backfilled
	backfilled += eventPass.backfilled
	if (eventPass.deletionStarted) {
		return stopForDeletion()
	}
	if (eventPass.retryableFailure) {
		await persistProgress({
			matchingSince: null,
			lastError: eventPass.blockedReason
				? `event backfill ${eventPass.blockedReason}`
				: 'event backfill mirror error or timeout',
		})
		console.warn(
			'mailbox-parity-event-backfill-retryable',
			state.userId,
			eventPass.blockedReason ?? 'error-or-timeout',
		)
		return {
			backfilled,
			compared: false,
			matched: false,
			mismatched: false,
			failed: true,
			budgetExhausted: false,
		}
	}
	if (eventPass.budgetExhausted) {
		await persistProgress({ matchingSince: null, lastError: null })
		return {
			backfilled,
			compared: false,
			matched: false,
			mismatched: false,
			failed: false,
			budgetExhausted: true,
		}
	}

	if (state.messagesCompletedAt == null || state.eventsCompletedAt == null) {
		await persistProgress({ matchingSince: null, lastError: null })
		return {
			backfilled,
			compared: false,
			matched: false,
			mismatched: false,
			failed: false,
			budgetExhausted: false,
		}
	}

	// Creation work ends the continuous soak window. Successful content replay
	// below may keep matching_since when the final compare matches.
	if (creationBackfilled > 0) {
		state = { ...state, matchingSince: null }
	}

	const contentPass = await replayContentUpdatesForUser({
		env: input.env,
		state,
		nowIso: input.nowIso,
		deadlineMs: input.deadlineMs,
		isDeleting,
	})
	state = contentPass.state
	backfilled += contentPass.backfilled
	if (contentPass.deletionStarted) {
		return stopForDeletion()
	}
	// Durably freeze a newly opened window even when this tick cannot finish it.
	if (contentPass.openedWindow && !contentPass.windowComplete) {
		await persistProgress({
			matchingSince: null,
			lastError: null,
		})
	}
	if (contentPass.retryableFailure) {
		await persistProgress({
			matchingSince: null,
			lastError: contentPass.blockedReason
				? `content replay ${contentPass.blockedReason}`
				: 'content replay mirror error or timeout',
		})
		console.warn(
			'mailbox-parity-content-replay-retryable',
			state.userId,
			contentPass.blockedReason ?? 'error-or-timeout',
		)
		return {
			backfilled,
			compared: false,
			matched: false,
			mismatched: false,
			failed: true,
			budgetExhausted: false,
		}
	}
	if (!contentPass.windowComplete) {
		// Freeze/retain upper + cursor; clear soak on incomplete budget ticks.
		await persistProgress({ matchingSince: null, lastError: null })
		return {
			backfilled,
			compared: false,
			matched: false,
			mismatched: false,
			failed: false,
			budgetExhausted: contentPass.budgetExhausted,
		}
	}

	if (await isDeleting()) {
		return stopForDeletion()
	}

	const compared = await compareParityForUser({
		env: input.env,
		state,
		nowIso: input.nowIso,
	})
	state = compared.state
	if (await isDeleting()) {
		return stopForDeletion()
	}
	await persistProgress({
		matchingSince: state.matchingSince,
		lastError: null,
	})
	return {
		backfilled,
		compared: true,
		matched: compared.matched,
		mismatched: !compared.matched,
		failed: false,
		budgetExhausted: false,
	}
}

export async function reconcileMailboxParity(input: {
	env: MailboxParityReconcileEnv
	now?: Date
	batchSize?: number
}): Promise<MailboxParityReconcileMetrics> {
	const now = input.now ?? new Date()
	const nowIso = now.toISOString()
	const deadlineMs = Date.now() + mailboxParityTimeBudgetMs
	const batchSize = input.batchSize ?? mailboxParityUserBatchSize
	const users = await listUsersForMailboxParity({
		db: input.env.APP_DB,
		limit: batchSize,
	})

	const metrics: MailboxParityReconcileMetrics = {
		scanned: 0,
		backfilled: 0,
		compared: 0,
		matched: 0,
		mismatched: 0,
		failed: 0,
	}

	for (const { userId } of users) {
		if (Date.now() >= deadlineMs) break
		metrics.scanned += 1
		try {
			const result = await reconcileOneUser({
				env: input.env,
				userId,
				nowIso,
				deadlineMs,
			})
			metrics.backfilled += result.backfilled
			if (result.compared) metrics.compared += 1
			if (result.matched) metrics.matched += 1
			if (result.mismatched) metrics.mismatched += 1
			if (result.failed) metrics.failed += 1
			if (result.budgetExhausted) break
		} catch (error) {
			metrics.failed += 1
			const lastError = safeParityErrorText(error)
			await rotateCheckedAt({
				db: input.env.APP_DB,
				userId,
				nowIso,
				lastError,
			}).catch(() => undefined)
			console.warn('mailbox-parity-reconcile-user-failed', userId, error)
		}
	}

	return metrics
}
