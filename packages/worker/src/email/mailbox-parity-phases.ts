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

export type MailboxParityPhaseResult = {
	state: MailboxParityUserState
	backfilled: number
	budgetExhausted: boolean
	retryableFailure: boolean
	/** Set when a selected mirror outcome must not advance the cursor. */
	blockedReason: string | null
}

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
}): Promise<MailboxParityPhaseResult & { deletionStarted: boolean }> {
	let state = input.state
	let backfilled = 0
	if (state.messagesCompletedAt != null) {
		return {
			state,
			backfilled,
			budgetExhausted: false,
			retryableFailure: false,
			blockedReason: null,
			deletionStarted: false,
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
				blockedReason: null,
				deletionStarted: false,
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
					blockedReason: null,
					deletionStarted: false,
				}
			}
			if (await input.isDeleting()) {
				state = { ...state, messageCursor: cursor }
				return {
					state,
					backfilled,
					budgetExhausted: false,
					retryableFailure: false,
					blockedReason: null,
					deletionStarted: true,
				}
			}
			const summary = await mirrorMailboxMessageGraphFromD1({
				env: input.env,
				db: input.env.APP_DB,
				userId: state.userId,
				messageId: row.id,
			})
			if (await input.isDeleting()) {
				state = { ...state, messageCursor: cursor }
				return {
					state,
					backfilled,
					budgetExhausted: false,
					retryableFailure: false,
					blockedReason: null,
					deletionStarted: true,
				}
			}
			if (!messageGraphAllowsCursorAdvance(summary)) {
				state = { ...state, messageCursor: cursor }
				return {
					state,
					backfilled,
					budgetExhausted: false,
					retryableFailure: true,
					blockedReason: `message graph ${summary.message.status}`,
					deletionStarted: false,
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
		blockedReason: null,
		deletionStarted: false,
	}
}

export async function backfillEventsForUser(input: {
	env: MailboxParityPhaseEnv
	state: MailboxParityUserState
	deadlineMs: number
	isDeleting: () => Promise<boolean>
}): Promise<MailboxParityPhaseResult & { deletionStarted: boolean }> {
	let state = input.state
	let backfilled = 0
	if (state.messagesCompletedAt == null) {
		return {
			state,
			backfilled,
			budgetExhausted: false,
			retryableFailure: false,
			blockedReason: null,
			deletionStarted: false,
		}
	}
	if (state.eventsCompletedAt != null) {
		return {
			state,
			backfilled,
			budgetExhausted: false,
			retryableFailure: false,
			blockedReason: null,
			deletionStarted: false,
		}
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
			return {
				state,
				backfilled,
				budgetExhausted: false,
				retryableFailure: false,
				blockedReason: null,
				deletionStarted: false,
			}
		}

		let cursor = state.eventCursor
		for (const row of page) {
			if (Date.now() >= input.deadlineMs) {
				state = { ...state, eventCursor: cursor }
				return {
					state,
					backfilled,
					budgetExhausted: true,
					retryableFailure: false,
					blockedReason: null,
					deletionStarted: false,
				}
			}
			if (await input.isDeleting()) {
				state = { ...state, eventCursor: cursor }
				return {
					state,
					backfilled,
					budgetExhausted: false,
					retryableFailure: false,
					blockedReason: null,
					deletionStarted: true,
				}
			}
			const result = await mirrorMailboxParityDeliveryEventFromD1({
				env: input.env,
				db: input.env.APP_DB,
				userId: state.userId,
				eventId: row.id,
			})
			if (await input.isDeleting()) {
				state = { ...state, eventCursor: cursor }
				return {
					state,
					backfilled,
					budgetExhausted: false,
					retryableFailure: false,
					blockedReason: null,
					deletionStarted: true,
				}
			}
			if (!eventMirrorAllowsCursorAdvance(result)) {
				state = { ...state, eventCursor: cursor }
				return {
					state,
					backfilled,
					budgetExhausted: false,
					retryableFailure: true,
					blockedReason:
						result.status === 'skipped'
							? `event skipped:${result.reason}`
							: `event ${result.status}`,
					deletionStarted: false,
				}
			}
			cursor = { createdAt: row.created_at, id: row.id }
			backfilled += 1
		}
		state = { ...state, eventCursor: cursor }
	}

	return {
		state,
		backfilled,
		budgetExhausted: true,
		retryableFailure: false,
		blockedReason: null,
		deletionStarted: false,
	}
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
}): Promise<
	MailboxParityPhaseResult & {
		deletionStarted: boolean
		windowComplete: boolean
		openedWindow: boolean
	}
> {
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
				state: {
					...state,
					contentWatermarkAt: upperBoundAt,
					contentReplayUpperAt: null,
					contentReplayCursor: null,
				},
				backfilled,
				budgetExhausted: false,
				retryableFailure: false,
				blockedReason: null,
				deletionStarted: false,
				windowComplete: true,
				openedWindow,
			}
		}

		for (const row of page) {
			if (Date.now() >= input.deadlineMs) {
				return {
					state: {
						...state,
						contentReplayUpperAt: upperBoundAt,
						contentReplayCursor: cursor,
					},
					backfilled,
					budgetExhausted: true,
					retryableFailure: false,
					blockedReason: null,
					deletionStarted: false,
					windowComplete: false,
					openedWindow,
				}
			}
			if (await input.isDeleting()) {
				return {
					state: {
						...state,
						contentReplayUpperAt: upperBoundAt,
						contentReplayCursor: cursor,
					},
					backfilled,
					budgetExhausted: false,
					retryableFailure: false,
					blockedReason: null,
					deletionStarted: true,
					windowComplete: false,
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
					state: {
						...state,
						contentReplayUpperAt: upperBoundAt,
						contentReplayCursor: cursor,
					},
					backfilled,
					budgetExhausted: false,
					retryableFailure: false,
					blockedReason: null,
					deletionStarted: true,
					windowComplete: false,
					openedWindow,
				}
			}
			if (!messageGraphAllowsCursorAdvance(summary)) {
				return {
					state: {
						...state,
						contentReplayUpperAt: upperBoundAt,
						contentReplayCursor: cursor,
					},
					backfilled,
					budgetExhausted: false,
					retryableFailure: true,
					blockedReason: `content replay ${summary.message.status}`,
					deletionStarted: false,
					windowComplete: false,
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
		state: {
			...state,
			contentReplayUpperAt: upperBoundAt,
			contentReplayCursor: cursor,
		},
		backfilled,
		budgetExhausted: true,
		retryableFailure: false,
		blockedReason: null,
		deletionStarted: false,
		windowComplete: false,
		openedWindow,
	}
}
