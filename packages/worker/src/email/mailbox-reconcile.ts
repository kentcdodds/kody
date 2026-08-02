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
	mailboxParityEventMirrorTimeoutMs,
	mailboxParityEventPageSize,
	mailboxParityMessagePageSize,
	mirrorMailboxParityDeliveryEventFromD1,
	replayContentUpdatesForUser,
	type MailboxParityContentPhaseResult,
	type MailboxParityCreationPhaseResult,
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
 * Bounded five-minute Mailbox backfill + count-parity reconciler.
 *
 * Discovers a small oldest-first page of non-deleting D1 mail owners (no DO
 * enumeration), mirrors message graphs then every owner delivery event as
 * page-sized `upsertDeliveryEvents` batches (repairing graph truncation;
 * {@link mailboxParityEventMirrorTimeoutMs}), durably keyset-replays messages
 * updated after the content watermark, then compares owner-scoped D1 counts
 * with `countMailbox` ({@link mailboxParityCountTimeoutMs}). D1 remains mail
 * authority; this lane never mutates
 * email_* rows and does not flip read authority.
 */

export const mailboxParityUserBatchSize = 16
export const mailboxParityTimeBudgetMs = 10_000
export const mailboxParityCountTimeoutMs = 5_000
export const mailboxParityLastErrorMaxBytes = 512

export {
	mailboxParityContentPageSize,
	mailboxParityEventMirrorTimeoutMs,
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

type MailboxParityCompareResult =
	| { status: 'matched'; state: MailboxParityUserState }
	| { status: 'mismatched_reset'; state: MailboxParityUserState }
	| {
			status: 'mismatched_purge_failed'
			state: MailboxParityUserState
			lastError: string
	  }

type MailboxParityUserTickResult =
	| { status: 'skipped' }
	| { status: 'deletion_stopped'; backfilled: number }
	| {
			status: 'phase_checkpoint'
			backfilled: number
			failed: boolean
			budgetExhausted: boolean
	  }
	| {
			status: 'compared'
			backfilled: number
			matched: boolean
			mismatched: boolean
			failed: boolean
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
 * Bounded Mailbox SQLite metadata purge (no R2). Used for account-deletion
 * races (best-effort) and count-mismatch rebuild (must observe success).
 */
async function purgeMailboxMetadata(input: {
	env: MailboxParityReconcileEnv
	userId: string
	preserveMessageTombstones?: boolean
}): Promise<
	{ ok: true } | { ok: false; reason: 'timeout' | 'error'; errorText: string }
> {
	try {
		const rpc = mailboxRpc({ env: input.env, userId: input.userId })
		const raced = await awaitMailboxMirrorRpc(
			input.preserveMessageTombstones
				? rpc.purgeForParityRebuild({ ownerId: input.userId })
				: rpc.purge(),
			mailboxMirrorRpcTimeoutMs,
		)
		if (!raced.ok) {
			return {
				ok: false,
				reason: 'timeout',
				errorText: 'mailbox metadata purge timeout',
			}
		}
		return { ok: true }
	} catch (error) {
		return {
			ok: false,
			reason: 'error',
			errorText: safeParityErrorText(error),
		}
	}
}

async function purgeMailboxBestEffort(input: {
	env: MailboxParityReconcileEnv
	userId: string
}) {
	const result = await purgeMailboxMetadata(input)
	if (!result.ok) {
		console.warn(
			'mailbox-parity-purge-on-delete-failed',
			input.userId,
			result.errorText,
		)
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
}): Promise<MailboxParityCompareResult> {
	const d1 = await countD1MailboxParity({
		db: input.env.APP_DB,
		userId: input.state.userId,
	})
	const raced = await awaitMailboxMirrorRpc(
		mailboxRpc({ env: input.env, userId: input.state.userId }).countMailbox(),
		mailboxParityCountTimeoutMs,
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
			status: 'matched',
			state: {
				...input.state,
				matchingSince: input.state.matchingSince ?? input.nowIso,
				mismatchCount: 0,
			},
		}
	}

	// DO may hold extras after D1 deletes. Purge graph metadata (no R2) before
	// rebuilding, but retain deletion tombstones so delayed D1 pages cannot
	// resurrect explicitly deleted messages during the migration.
	const purged = await purgeMailboxMetadata({
		env: input.env,
		userId: input.state.userId,
		preserveMessageTombstones: true,
	})
	if (!purged.ok) {
		console.warn(
			'mailbox-parity-mismatch-purge-failed',
			input.state.userId,
			purged.reason,
			purged.errorText,
		)
		return {
			status: 'mismatched_purge_failed',
			state: {
				...input.state,
				matchingSince: null,
				mismatchCount: input.state.mismatchCount + 1,
			},
			lastError: purged.errorText,
		}
	}

	return {
		status: 'mismatched_reset',
		state: {
			...input.state,
			matchingSince: null,
			mismatchCount: input.state.mismatchCount + 1,
			messageCursor: null,
			messagesCompletedAt: null,
			eventCursor: null,
			eventsCompletedAt: null,
			contentWatermarkAt: null,
			contentReplayUpperAt: null,
			contentReplayCursor: null,
		},
	}
}

function creationPhaseCheckpoint(input: {
	phase: 'message' | 'event'
	result: MailboxParityCreationPhaseResult
}): {
	kind: 'continue' | 'deletion' | 'failed' | 'budget'
	lastError: string | null
	warnDetail: string | null
} {
	switch (input.result.status) {
		case 'complete':
			return { kind: 'continue', lastError: null, warnDetail: null }
		case 'deletion_started':
			return { kind: 'deletion', lastError: null, warnDetail: null }
		case 'budget_exhausted':
			return { kind: 'budget', lastError: null, warnDetail: null }
		case 'retryable_failure': {
			const prefix =
				input.phase === 'message' ? 'message backfill' : 'event backfill'
			return {
				kind: 'failed',
				lastError: `${prefix} ${input.result.blockedReason}`,
				warnDetail: input.result.blockedReason,
			}
		}
		default: {
			const exhaustive: never = input.result
			throw new Error(
				`Unhandled creation phase status: ${JSON.stringify(exhaustive)}`,
			)
		}
	}
}

function contentPhaseCheckpoint(input: {
	result: MailboxParityContentPhaseResult
}): {
	kind: 'continue' | 'deletion' | 'failed' | 'budget'
	lastError: string | null
	warnDetail: string | null
	freezeOpenedWindow: boolean
} {
	switch (input.result.status) {
		case 'complete':
			return {
				kind: 'continue',
				lastError: null,
				warnDetail: null,
				freezeOpenedWindow: false,
			}
		case 'deletion_started':
			return {
				kind: 'deletion',
				lastError: null,
				warnDetail: null,
				freezeOpenedWindow: false,
			}
		case 'budget_exhausted':
			return {
				kind: 'budget',
				lastError: null,
				warnDetail: null,
				freezeOpenedWindow: input.result.openedWindow,
			}
		case 'retryable_failure':
			return {
				kind: 'failed',
				lastError: `content replay ${input.result.blockedReason}`,
				warnDetail: input.result.blockedReason,
				freezeOpenedWindow: input.result.openedWindow,
			}
		default: {
			const exhaustive: never = input.result
			throw new Error(
				`Unhandled content phase status: ${JSON.stringify(exhaustive)}`,
			)
		}
	}
}

async function reconcileOneUser(input: {
	env: MailboxParityReconcileEnv
	userId: string
	nowIso: string
	deadlineMs: number
}): Promise<MailboxParityUserTickResult> {
	const loaded = await loadUserParityState({
		db: input.env.APP_DB,
		userId: input.userId,
	})
	if (!loaded) {
		return { status: 'skipped' }
	}

	let state = loaded
	let backfilled = 0
	let creationBackfilled = 0

	const isDeleting = () =>
		isUserDeleting({ db: input.env.APP_DB, userId: state.userId })

	const stopForDeletion = async (): Promise<MailboxParityUserTickResult> => {
		await purgeMailboxBestEffort({
			env: input.env,
			userId: state.userId,
		})
		return { status: 'deletion_stopped', backfilled }
	}

	const persistCheckpoint = async (checkpoint: {
		matchingSince: string | null
		lastError: string | null
	}) => {
		await persistUserParityProgress({
			db: input.env.APP_DB,
			userId: state.userId,
			nowIso: input.nowIso,
			matchingSince: checkpoint.matchingSince,
			mismatchCount: state.mismatchCount,
			contentWatermarkAt: state.contentWatermarkAt,
			contentReplayUpperAt: state.contentReplayUpperAt,
			contentReplayCursor: state.contentReplayCursor,
			messageCursor: state.messageCursor,
			messagesCompletedAt: state.messagesCompletedAt,
			eventCursor: state.eventCursor,
			eventsCompletedAt: state.eventsCompletedAt,
			lastError: checkpoint.lastError,
		})
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
	const messageCheckpoint = creationPhaseCheckpoint({
		phase: 'message',
		result: messagePass,
	})
	switch (messageCheckpoint.kind) {
		case 'continue':
			break
		case 'deletion':
			return stopForDeletion()
		case 'failed':
			await persistCheckpoint({
				matchingSince: null,
				lastError: messageCheckpoint.lastError,
			})
			console.warn(
				'mailbox-parity-message-backfill-retryable',
				state.userId,
				messageCheckpoint.warnDetail ?? 'error-or-timeout',
			)
			return {
				status: 'phase_checkpoint',
				backfilled,
				failed: true,
				budgetExhausted: false,
			}
		case 'budget':
			await persistCheckpoint({ matchingSince: null, lastError: null })
			return {
				status: 'phase_checkpoint',
				backfilled,
				failed: false,
				budgetExhausted: true,
			}
		default: {
			const exhaustive: never = messageCheckpoint.kind
			throw new Error(`Unhandled message checkpoint: ${exhaustive}`)
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
	const eventCheckpoint = creationPhaseCheckpoint({
		phase: 'event',
		result: eventPass,
	})
	switch (eventCheckpoint.kind) {
		case 'continue':
			break
		case 'deletion':
			return stopForDeletion()
		case 'failed':
			await persistCheckpoint({
				matchingSince: null,
				lastError: eventCheckpoint.lastError,
			})
			console.warn(
				'mailbox-parity-event-backfill-retryable',
				state.userId,
				eventCheckpoint.warnDetail ?? 'error-or-timeout',
			)
			return {
				status: 'phase_checkpoint',
				backfilled,
				failed: true,
				budgetExhausted: false,
			}
		case 'budget':
			await persistCheckpoint({ matchingSince: null, lastError: null })
			return {
				status: 'phase_checkpoint',
				backfilled,
				failed: false,
				budgetExhausted: true,
			}
		default: {
			const exhaustive: never = eventCheckpoint.kind
			throw new Error(`Unhandled event checkpoint: ${exhaustive}`)
		}
	}

	if (state.messagesCompletedAt == null || state.eventsCompletedAt == null) {
		await persistCheckpoint({ matchingSince: null, lastError: null })
		return {
			status: 'phase_checkpoint',
			backfilled,
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
	const contentCheckpoint = contentPhaseCheckpoint({ result: contentPass })
	switch (contentCheckpoint.kind) {
		case 'continue':
			break
		case 'deletion':
			return stopForDeletion()
		case 'failed':
			// Durably freeze a newly opened window even when this tick cannot finish it.
			if (contentCheckpoint.freezeOpenedWindow) {
				await persistCheckpoint({ matchingSince: null, lastError: null })
			}
			await persistCheckpoint({
				matchingSince: null,
				lastError: contentCheckpoint.lastError,
			})
			console.warn(
				'mailbox-parity-content-replay-retryable',
				state.userId,
				contentCheckpoint.warnDetail ?? 'error-or-timeout',
			)
			return {
				status: 'phase_checkpoint',
				backfilled,
				failed: true,
				budgetExhausted: false,
			}
		case 'budget':
			if (contentCheckpoint.freezeOpenedWindow) {
				await persistCheckpoint({ matchingSince: null, lastError: null })
			}
			// Freeze/retain upper + cursor; clear soak on incomplete budget ticks.
			await persistCheckpoint({ matchingSince: null, lastError: null })
			return {
				status: 'phase_checkpoint',
				backfilled,
				failed: false,
				budgetExhausted: true,
			}
		default: {
			const exhaustive: never = contentCheckpoint.kind
			throw new Error(`Unhandled content checkpoint: ${exhaustive}`)
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

	switch (compared.status) {
		case 'matched':
			await persistCheckpoint({
				matchingSince: state.matchingSince,
				lastError: null,
			})
			return {
				status: 'compared',
				backfilled,
				matched: true,
				mismatched: false,
				failed: false,
			}
		case 'mismatched_reset':
			await persistCheckpoint({
				matchingSince: state.matchingSince,
				lastError: null,
			})
			return {
				status: 'compared',
				backfilled,
				matched: false,
				mismatched: true,
				failed: false,
			}
		case 'mismatched_purge_failed':
			await persistCheckpoint({
				matchingSince: state.matchingSince,
				lastError: compared.lastError,
			})
			return {
				status: 'compared',
				backfilled,
				matched: false,
				mismatched: true,
				failed: true,
			}
		default: {
			const exhaustive: never = compared
			throw new Error(`Unhandled compare status: ${JSON.stringify(exhaustive)}`)
		}
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
			switch (result.status) {
				case 'skipped':
					break
				case 'deletion_stopped':
					metrics.backfilled += result.backfilled
					break
				case 'phase_checkpoint':
					metrics.backfilled += result.backfilled
					if (result.failed) metrics.failed += 1
					if (result.budgetExhausted) {
						// Stop scanning further users this tick.
						return metrics
					}
					break
				case 'compared':
					metrics.backfilled += result.backfilled
					metrics.compared += 1
					if (result.matched) metrics.matched += 1
					if (result.mismatched) metrics.mismatched += 1
					if (result.failed) metrics.failed += 1
					break
				default: {
					const exhaustive: never = result
					throw new Error(
						`Unhandled user tick status: ${JSON.stringify(exhaustive)}`,
					)
				}
			}
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
