import {
	mirrorMailboxDeliveryEventFromD1,
	mirrorMailboxMessageGraphFromD1,
	type MailboxLiveMirrorEnv,
	type MailboxLiveMirrorGraphSummary,
} from './mailbox-live-mirror.ts'
import { type MailboxMirrorResult } from './mailbox-mirror.ts'
import {
	listContentReplayPage,
	listEventBackfillPage,
	listMessageBackfillPage,
	type MailboxParityContentCursor,
	type MailboxParityUserState,
} from './mailbox-parity-repo.ts'

export const mailboxParityMessagePageSize = 10
export const mailboxParityEventPageSize = 25
export const mailboxParityContentPageSize = 10

export type MailboxParityPhaseEnv = MailboxLiveMirrorEnv & {
	APP_DB: D1Database
}

type MailboxParityPhaseBase = {
	state: MailboxParityUserState
	backfilled: number
}

/** Creation (message/event) phase outcome. */
export type MailboxParityCreationPhaseResult =
	| (MailboxParityPhaseBase & { status: 'complete' })
	| (MailboxParityPhaseBase & { status: 'budget_exhausted' })
	| (MailboxParityPhaseBase & {
			status: 'retryable_failure'
			blockedReason: string
	  })
	| (MailboxParityPhaseBase & { status: 'deletion_started' })

/** Content-replay phase outcome (`complete` ≡ full window finished). */
export type MailboxParityContentPhaseResult =
	| (MailboxParityPhaseBase & {
			status: 'complete'
			openedWindow: boolean
	  })
	| (MailboxParityPhaseBase & {
			status: 'budget_exhausted'
			openedWindow: boolean
	  })
	| (MailboxParityPhaseBase & {
			status: 'retryable_failure'
			blockedReason: string
			openedWindow: boolean
	  })
	| (MailboxParityPhaseBase & {
			status: 'deletion_started'
			openedWindow: boolean
	  })

/**
 * Message graph cursor may advance only on mirrored/stale. missing / skipped /
 * timeout / error must not advance (selected D1 row was expected).
 * `eventsTruncated` is acceptable: the complete owner event phase remirrors
 * every delivery event afterward.
 */
export function messageGraphAllowsCursorAdvance(
	summary: MailboxLiveMirrorGraphSummary,
): boolean {
	switch (summary.message.status) {
		case 'mirrored':
		case 'stale':
			break
		case 'missing':
		case 'timeout':
		case 'error':
		case 'skipped':
			return false
		default: {
			const exhaustive: never = summary.message
			throw new Error(
				`Unhandled graph message status: ${JSON.stringify(exhaustive)}`,
			)
		}
	}
	return !summary.events.some((event) => {
		switch (event.result.status) {
			case 'mirrored':
			case 'stale':
			case 'missing':
				return false
			case 'timeout':
			case 'error':
			case 'skipped':
				return true
			default: {
				const exhaustive: never = event.result
				throw new Error(
					`Unhandled graph event status: ${JSON.stringify(exhaustive)}`,
				)
			}
		}
	})
}

/**
 * Event-phase cursor: mirrored/stale advance; missing advances (D1 row may have
 * been deleted concurrently after selection); skipped (incl. unconfigured),
 * timeout, and error must not advance.
 */
export function eventMirrorAllowsCursorAdvance(
	result: MailboxMirrorResult,
): boolean {
	switch (result.status) {
		case 'mirrored':
		case 'stale':
		case 'missing':
			return true
		case 'timeout':
		case 'error':
		case 'skipped':
			return false
		default: {
			const exhaustive: never = result
			throw new Error(
				`Unhandled event mirror status: ${JSON.stringify(exhaustive)}`,
			)
		}
	}
}

/**
 * Load one owner delivery-event projection from D1 and mirror it.
 * Thin cohesive wrapper over {@link mirrorMailboxDeliveryEventFromD1}.
 */
export async function mirrorMailboxParityDeliveryEventFromD1(input: {
	env: MailboxLiveMirrorEnv
	db: D1Database
	userId: string
	eventId: string
}): Promise<MailboxMirrorResult> {
	return mirrorMailboxDeliveryEventFromD1(input)
}

export function resolveContentReplayUpperBound(input: {
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

export async function backfillMessagesForUser(input: {
	env: MailboxParityPhaseEnv
	state: MailboxParityUserState
	deadlineMs: number
	isDeleting: () => Promise<boolean>
}): Promise<MailboxParityCreationPhaseResult> {
	let state = input.state
	let backfilled = 0
	if (state.messagesCompletedAt != null) {
		return { status: 'complete', state, backfilled }
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
			return { status: 'complete', state, backfilled }
		}

		let cursor = state.messageCursor
		for (const row of page) {
			if (Date.now() >= input.deadlineMs) {
				state = { ...state, messageCursor: cursor }
				return { status: 'budget_exhausted', state, backfilled }
			}
			if (await input.isDeleting()) {
				state = { ...state, messageCursor: cursor }
				return { status: 'deletion_started', state, backfilled }
			}
			const summary = await mirrorMailboxMessageGraphFromD1({
				env: input.env,
				db: input.env.APP_DB,
				userId: state.userId,
				messageId: row.id,
			})
			if (await input.isDeleting()) {
				state = { ...state, messageCursor: cursor }
				return { status: 'deletion_started', state, backfilled }
			}
			if (!messageGraphAllowsCursorAdvance(summary)) {
				state = { ...state, messageCursor: cursor }
				return {
					status: 'retryable_failure',
					state,
					backfilled,
					blockedReason: `message graph ${summary.message.status}`,
				}
			}
			cursor = { createdAt: row.created_at, id: row.id }
			backfilled += 1
		}
		state = { ...state, messageCursor: cursor }
	}

	return { status: 'budget_exhausted', state, backfilled }
}

export async function backfillEventsForUser(input: {
	env: MailboxParityPhaseEnv
	state: MailboxParityUserState
	deadlineMs: number
	isDeleting: () => Promise<boolean>
}): Promise<MailboxParityCreationPhaseResult> {
	let state = input.state
	let backfilled = 0
	if (state.messagesCompletedAt == null) {
		return { status: 'complete', state, backfilled }
	}
	if (state.eventsCompletedAt != null) {
		return { status: 'complete', state, backfilled }
	}

	while (Date.now() < input.deadlineMs) {
		const page = await listEventBackfillPage({
			db: input.env.APP_DB,
			userId: state.userId,
			cursor: state.eventCursor,
			limit: mailboxParityEventPageSize,
		})
		if (page.length === 0) {
			state = {
				...state,
				eventsCompletedAt: new Date().toISOString(),
			}
			return { status: 'complete', state, backfilled }
		}

		let cursor = state.eventCursor
		for (const row of page) {
			if (Date.now() >= input.deadlineMs) {
				state = { ...state, eventCursor: cursor }
				return { status: 'budget_exhausted', state, backfilled }
			}
			if (await input.isDeleting()) {
				state = { ...state, eventCursor: cursor }
				return { status: 'deletion_started', state, backfilled }
			}
			const result = await mirrorMailboxParityDeliveryEventFromD1({
				env: input.env,
				db: input.env.APP_DB,
				userId: state.userId,
				eventId: row.id,
			})
			if (await input.isDeleting()) {
				state = { ...state, eventCursor: cursor }
				return { status: 'deletion_started', state, backfilled }
			}
			if (!eventMirrorAllowsCursorAdvance(result)) {
				state = { ...state, eventCursor: cursor }
				return {
					status: 'retryable_failure',
					state,
					backfilled,
					blockedReason:
						result.status === 'skipped'
							? `event skipped:${result.reason}`
							: `event ${result.status}`,
				}
			}
			cursor = { createdAt: row.created_at, id: row.id }
			backfilled += 1
		}
		state = { ...state, eventCursor: cursor }
	}

	return { status: 'budget_exhausted', state, backfilled }
}

/**
 * Durable content replay over (watermark, upper]. Freezes upper when opening a
 * window; resumes cursor across ticks; advances watermark only on full success.
 */
export async function replayContentUpdatesForUser(input: {
	env: MailboxParityPhaseEnv
	state: MailboxParityUserState
	nowIso: string
	deadlineMs: number
	isDeleting: () => Promise<boolean>
}): Promise<MailboxParityContentPhaseResult> {
	let state = input.state
	const watermarkAt = state.contentWatermarkAt ?? input.nowIso
	let openedWindow = false

	if (state.contentReplayUpperAt == null) {
		const upperBoundAt = resolveContentReplayUpperBound({
			nowIso: input.nowIso,
			watermarkAt,
		})
		state = {
			...state,
			contentWatermarkAt: watermarkAt,
			contentReplayUpperAt: upperBoundAt,
			contentReplayCursor: null,
		}
		openedWindow = true
	}

	const upperBoundAt = state.contentReplayUpperAt!
	let cursor: MailboxParityContentCursor | null = state.contentReplayCursor
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
				status: 'complete',
				state: {
					...state,
					contentWatermarkAt: upperBoundAt,
					contentReplayUpperAt: null,
					contentReplayCursor: null,
				},
				backfilled,
				openedWindow,
			}
		}

		for (const row of page) {
			if (Date.now() >= input.deadlineMs) {
				return {
					status: 'budget_exhausted',
					state: {
						...state,
						contentReplayUpperAt: upperBoundAt,
						contentReplayCursor: cursor,
					},
					backfilled,
					openedWindow,
				}
			}
			if (await input.isDeleting()) {
				return {
					status: 'deletion_started',
					state: {
						...state,
						contentReplayUpperAt: upperBoundAt,
						contentReplayCursor: cursor,
					},
					backfilled,
					openedWindow,
				}
			}
			const summary = await mirrorMailboxMessageGraphFromD1({
				env: input.env,
				db: input.env.APP_DB,
				userId: state.userId,
				messageId: row.id,
			})
			if (await input.isDeleting()) {
				return {
					status: 'deletion_started',
					state: {
						...state,
						contentReplayUpperAt: upperBoundAt,
						contentReplayCursor: cursor,
					},
					backfilled,
					openedWindow,
				}
			}
			if (!messageGraphAllowsCursorAdvance(summary)) {
				return {
					status: 'retryable_failure',
					state: {
						...state,
						contentReplayUpperAt: upperBoundAt,
						contentReplayCursor: cursor,
					},
					backfilled,
					blockedReason: `content replay ${summary.message.status}`,
					openedWindow,
				}
			}
			cursor = { updatedAt: row.updated_at, id: row.id }
			backfilled += 1
			state = {
				...state,
				contentReplayUpperAt: upperBoundAt,
				contentReplayCursor: cursor,
			}
		}
	}

	return {
		status: 'budget_exhausted',
		state: {
			...state,
			contentReplayUpperAt: upperBoundAt,
			contentReplayCursor: cursor,
		},
		backfilled,
		openedWindow,
	}
}
