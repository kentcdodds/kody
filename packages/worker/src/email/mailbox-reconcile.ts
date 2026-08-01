import { truncateToUtf8Bytes } from '@kody-internal/shared/backup-restore-safety.ts'
import { mailboxRpc } from './mailbox-client.ts'
import {
	mirrorMailboxDeliveryEventFromD1,
	mirrorMailboxMessageGraphFromD1,
	type MailboxLiveMirrorEnv,
	type MailboxLiveMirrorGraphSummary,
} from './mailbox-live-mirror.ts'
import {
	awaitMailboxMirrorRpc,
	mailboxMirrorRpcTimeoutMs,
	type MailboxMirrorResult,
} from './mailbox-mirror.ts'
import {
	recordMailboxParityEvent,
	type MailboxParityOperation,
} from './mailbox-parity-events.ts'
import {
	countD1MailboxParity,
	listContentReplayPage,
	listMessageBackfillPage,
	listOrphanDeliveryEventBackfillPage,
	listUsersForMailboxParity,
	loadUserParityState,
	persistUserParityProgress,
	rotateCheckedAt,
	type MailboxParityContentCursor,
	type MailboxParityUserState,
} from './mailbox-parity-repo.ts'
import { type MailboxCountResult } from './mailbox-types.ts'

/**
 * Bounded hourly Mailbox backfill + count-parity reconciler.
 *
 * Discovers a small oldest-first page of non-deleting D1 mail owners (no DO
 * enumeration), mirrors message graphs then message_id-null orphan delivery
 * events through existing live-mirror helpers, then keyset-replays messages
 * updated after the content watermark before comparing owner-scoped D1 counts
 * with `countMailbox`. D1 remains mail authority; this lane never mutates
 * email_* rows and does not flip read authority.
 */

export const mailboxParityUserBatchSize = 8
export const mailboxParityMessagePageSize = 10
export const mailboxParityOrphanEventPageSize = 25
export const mailboxParityContentPageSize = 10
export const mailboxParityTimeBudgetMs = 10_000
export const mailboxParityLastErrorMaxBytes = 512

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
	listOrphanDeliveryEventBackfillPage,
	listUsersForMailboxParity,
}

function isRetryableMirrorResult(result: MailboxMirrorResult): boolean {
	return result.status === 'error' || result.status === 'timeout'
}

function graphMirrorSucceeded(summary: MailboxLiveMirrorGraphSummary): boolean {
	if (isRetryableMirrorResult(summary.message)) return false
	return !summary.events.some((event) => isRetryableMirrorResult(event.result))
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

/**
 * Load one orphan delivery-event projection from D1 and mirror it.
 * Thin cohesive wrapper over {@link mirrorMailboxDeliveryEventFromD1}.
 */
export async function mirrorMailboxOrphanDeliveryEventFromD1(input: {
	env: MailboxLiveMirrorEnv
	db: D1Database
	userId: string
	eventId: string
}): Promise<MailboxMirrorResult> {
	return mirrorMailboxDeliveryEventFromD1(input)
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

async function backfillMessagesForUser(input: {
	env: MailboxParityReconcileEnv
	state: MailboxParityUserState
	deadlineMs: number
}): Promise<{
	state: MailboxParityUserState
	backfilled: number
	budgetExhausted: boolean
	retryableFailure: boolean
}> {
	let state = input.state
	let backfilled = 0
	if (state.messagesCompletedAt != null) {
		return {
			state,
			backfilled,
			budgetExhausted: false,
			retryableFailure: false,
		}
	}

	while (Date.now() < input.deadlineMs) {
		const page = await listMessageBackfillPage({
			db: input.env.APP_DB,
			userId: state.userId,
			cursor: state.messageCursor,
			limit: mailboxParityMessagePageSize,
		})
		if (page.length === 0) {
			state = {
				...state,
				messagesCompletedAt: new Date().toISOString(),
			}
			return {
				state,
				backfilled,
				budgetExhausted: false,
				retryableFailure: false,
			}
		}

		let cursor = state.messageCursor
		for (const row of page) {
			if (Date.now() >= input.deadlineMs) {
				state = { ...state, messageCursor: cursor }
				return {
					state,
					backfilled,
					budgetExhausted: true,
					retryableFailure: false,
				}
			}
			const summary = await mirrorMailboxMessageGraphFromD1({
				env: input.env,
				db: input.env.APP_DB,
				userId: state.userId,
				messageId: row.id,
			})
			if (!graphMirrorSucceeded(summary)) {
				state = { ...state, messageCursor: cursor }
				return {
					state,
					backfilled,
					budgetExhausted: false,
					retryableFailure: true,
				}
			}
			cursor = { createdAt: row.created_at, id: row.id }
			backfilled += 1
		}
		state = { ...state, messageCursor: cursor }
	}

	return {
		state,
		backfilled,
		budgetExhausted: true,
		retryableFailure: false,
	}
}

async function backfillOrphanEventsForUser(input: {
	env: MailboxParityReconcileEnv
	state: MailboxParityUserState
	deadlineMs: number
}): Promise<{
	state: MailboxParityUserState
	backfilled: number
	budgetExhausted: boolean
	retryableFailure: boolean
}> {
	let state = input.state
	let backfilled = 0
	if (state.messagesCompletedAt == null) {
		return {
			state,
			backfilled,
			budgetExhausted: false,
			retryableFailure: false,
		}
	}
	if (state.orphanEventsCompletedAt != null) {
		return {
			state,
			backfilled,
			budgetExhausted: false,
			retryableFailure: false,
		}
	}

	while (Date.now() < input.deadlineMs) {
		const page = await listOrphanDeliveryEventBackfillPage({
			db: input.env.APP_DB,
			userId: state.userId,
			cursor: state.orphanEventCursor,
			limit: mailboxParityOrphanEventPageSize,
		})
		if (page.length === 0) {
			state = {
				...state,
				orphanEventsCompletedAt: new Date().toISOString(),
			}
			return {
				state,
				backfilled,
				budgetExhausted: false,
				retryableFailure: false,
			}
		}

		let cursor = state.orphanEventCursor
		for (const row of page) {
			if (Date.now() >= input.deadlineMs) {
				state = { ...state, orphanEventCursor: cursor }
				return {
					state,
					backfilled,
					budgetExhausted: true,
					retryableFailure: false,
				}
			}
			const result = await mirrorMailboxOrphanDeliveryEventFromD1({
				env: input.env,
				db: input.env.APP_DB,
				userId: state.userId,
				eventId: row.id,
			})
			if (isRetryableMirrorResult(result)) {
				state = { ...state, orphanEventCursor: cursor }
				return {
					state,
					backfilled,
					budgetExhausted: false,
					retryableFailure: true,
				}
			}
			cursor = { createdAt: row.created_at, id: row.id }
			backfilled += 1
		}
		state = { ...state, orphanEventCursor: cursor }
	}

	return {
		state,
		backfilled,
		budgetExhausted: true,
		retryableFailure: false,
	}
}

/**
 * Baseline is established before the first creation scan. When it still equals
 * this run's nowIso, sample wall time so same-run updates after the baseline
 * are included; otherwise the run's nowIso is the upper bound.
 */
function resolveContentReplayUpperBound(input: {
	nowIso: string
	watermarkAt: string
}): string {
	let upperBoundAt = input.nowIso
	if (input.watermarkAt === input.nowIso) {
		const wallIso = new Date().toISOString()
		if (wallIso > upperBoundAt) upperBoundAt = wallIso
	}
	if (upperBoundAt < input.watermarkAt) return input.watermarkAt
	return upperBoundAt
}

/**
 * Persist the content watermark at the start of the first backfill attempt so
 * updates during creation/orphan mirroring cannot fall before a completion-time
 * baseline. Retained across incomplete/error ticks.
 */
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
		messageCursor: state.messageCursor,
		messagesCompletedAt: state.messagesCompletedAt,
		orphanEventCursor: state.orphanEventCursor,
		orphanEventsCompletedAt: state.orphanEventsCompletedAt,
		lastError: null,
	})
	return state
}

/**
 * After initial creation/orphan backfill completes: keyset-replay every owner
 * message with updated_at in (watermark, current-now]. Watermark advances only
 * when the entire window succeeds; in-tick cursor avoids skipping equal
 * timestamps. Always replay — never treat a fresh baseline as an empty skip.
 */
async function replayContentUpdatesForUser(input: {
	env: MailboxParityReconcileEnv
	state: MailboxParityUserState
	nowIso: string
	deadlineMs: number
}): Promise<{
	state: MailboxParityUserState
	backfilled: number
	budgetExhausted: boolean
	retryableFailure: boolean
	windowComplete: boolean
}> {
	const state = input.state
	const watermarkAt = state.contentWatermarkAt ?? input.nowIso
	const upperBoundAt = resolveContentReplayUpperBound({
		nowIso: input.nowIso,
		watermarkAt,
	})
	let cursor: MailboxParityContentCursor | null = null
	let backfilled = 0

	while (Date.now() < input.deadlineMs) {
		const page = await listContentReplayPage({
			db: input.env.APP_DB,
			userId: state.userId,
			watermarkAt,
			upperBoundAt,
			cursor,
			limit: mailboxParityContentPageSize,
		})
		if (page.length === 0) {
			return {
				state: { ...state, contentWatermarkAt: upperBoundAt },
				backfilled,
				budgetExhausted: false,
				retryableFailure: false,
				windowComplete: true,
			}
		}

		for (const row of page) {
			if (Date.now() >= input.deadlineMs) {
				return {
					state,
					backfilled,
					budgetExhausted: true,
					retryableFailure: false,
					windowComplete: false,
				}
			}
			const summary = await mirrorMailboxMessageGraphFromD1({
				env: input.env,
				db: input.env.APP_DB,
				userId: state.userId,
				messageId: row.id,
			})
			if (!graphMirrorSucceeded(summary)) {
				return {
					state,
					backfilled,
					budgetExhausted: false,
					retryableFailure: true,
					windowComplete: false,
				}
			}
			cursor = { updatedAt: row.updated_at, id: row.id }
			backfilled += 1
		}
	}

	return {
		state,
		backfilled,
		budgetExhausted: true,
		retryableFailure: false,
		windowComplete: false,
	}
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
	// Reopen bounded creation/orphan backfill after completed cursors so later
	// live rows past the retained keyset are mirrored on the next ticks; keep
	// the content watermark so classification updates remain covered.
	return {
		state: {
			...input.state,
			matchingSince: null,
			mismatchCount: input.state.mismatchCount + 1,
			messagesCompletedAt: null,
			orphanEventsCompletedAt: null,
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
	let initialBackfilled = 0

	const persistIncomplete = async (inputPersist: {
		lastError: string | null
	}) => {
		await persistUserParityProgress({
			db: input.env.APP_DB,
			userId: state.userId,
			nowIso: input.nowIso,
			// Soak cannot survive incomplete/error/backfill ticks.
			matchingSince: null,
			mismatchCount: state.mismatchCount,
			contentWatermarkAt: state.contentWatermarkAt,
			messageCursor: state.messageCursor,
			messagesCompletedAt: state.messagesCompletedAt,
			orphanEventCursor: state.orphanEventCursor,
			orphanEventsCompletedAt: state.orphanEventsCompletedAt,
			lastError: inputPersist.lastError,
		})
	}

	// Baseline before scanning so mid-backfill updates stay inside the replay window.
	state = await ensureContentWatermarkBaseline({
		db: input.env.APP_DB,
		state,
		nowIso: input.nowIso,
	})

	const messagePass = await backfillMessagesForUser({
		env: input.env,
		state,
		deadlineMs: input.deadlineMs,
	})
	state = messagePass.state
	initialBackfilled += messagePass.backfilled
	backfilled += messagePass.backfilled
	if (messagePass.retryableFailure) {
		await persistIncomplete({
			lastError: 'message backfill mirror error or timeout',
		})
		console.warn(
			'mailbox-parity-message-backfill-retryable',
			state.userId,
			'error-or-timeout',
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
		await persistIncomplete({ lastError: null })
		return {
			backfilled,
			compared: false,
			matched: false,
			mismatched: false,
			failed: false,
			budgetExhausted: true,
		}
	}

	const orphanPass = await backfillOrphanEventsForUser({
		env: input.env,
		state,
		deadlineMs: input.deadlineMs,
	})
	state = orphanPass.state
	initialBackfilled += orphanPass.backfilled
	backfilled += orphanPass.backfilled
	if (orphanPass.retryableFailure) {
		await persistIncomplete({
			lastError: 'orphan-event backfill mirror error or timeout',
		})
		console.warn(
			'mailbox-parity-orphan-event-backfill-retryable',
			state.userId,
			'error-or-timeout',
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
	if (orphanPass.budgetExhausted) {
		await persistIncomplete({ lastError: null })
		return {
			backfilled,
			compared: false,
			matched: false,
			mismatched: false,
			failed: false,
			budgetExhausted: true,
		}
	}

	if (
		state.messagesCompletedAt == null ||
		state.orphanEventsCompletedAt == null
	) {
		await persistIncomplete({ lastError: null })
		return {
			backfilled,
			compared: false,
			matched: false,
			mismatched: false,
			failed: false,
			budgetExhausted: false,
		}
	}

	// Initial creation/orphan work ends the continuous soak window. Successful
	// content replay below may keep matching_since when the final compare matches.
	if (initialBackfilled > 0) {
		state = { ...state, matchingSince: null }
	}

	const contentPass = await replayContentUpdatesForUser({
		env: input.env,
		state,
		nowIso: input.nowIso,
		deadlineMs: input.deadlineMs,
	})
	state = contentPass.state
	backfilled += contentPass.backfilled
	if (contentPass.retryableFailure) {
		await persistIncomplete({
			lastError: 'content replay mirror error or timeout',
		})
		console.warn(
			'mailbox-parity-content-replay-retryable',
			state.userId,
			'error-or-timeout',
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
		await persistIncomplete({ lastError: null })
		return {
			backfilled,
			compared: false,
			matched: false,
			mismatched: false,
			failed: false,
			budgetExhausted: contentPass.budgetExhausted,
		}
	}

	const compared = await compareParityForUser({
		env: input.env,
		state,
		nowIso: input.nowIso,
	})
	state = compared.state
	await persistUserParityProgress({
		db: input.env.APP_DB,
		userId: state.userId,
		nowIso: input.nowIso,
		matchingSince: state.matchingSince,
		mismatchCount: state.mismatchCount,
		contentWatermarkAt: state.contentWatermarkAt,
		messageCursor: state.messageCursor,
		messagesCompletedAt: state.messagesCompletedAt,
		orphanEventCursor: state.orphanEventCursor,
		orphanEventsCompletedAt: state.orphanEventsCompletedAt,
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
