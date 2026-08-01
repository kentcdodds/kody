import { isSystemEmailOwner } from './email-owner.ts'
import { processInboundDeliveryEffects } from './inbound-effects.ts'
import {
	mirrorMailboxDeliveryEventFromD1,
	mirrorMailboxMessageGraphFromD1,
	type MailboxLiveMirrorEnv,
} from './mailbox-live-mirror.ts'
import { type EmailReportingEnv } from './reporting-events.ts'

/**
 * Env surface for inbound Mailbox terminal coordination.
 * D1 remains authoritative; Mailbox dual-write is best-effort after commit.
 */
export type InboundMailboxEnv = Pick<
	Env,
	| 'APP_DB'
	| 'BUNDLE_ARTIFACTS_KV'
	| 'APP_BASE_URL'
	| 'USAGE_EVENTS'
	| 'MAILBOX'
	| 'EMAIL_EVENTS'
> &
	EmailReportingEnv &
	MailboxLiveMirrorEnv

export type InboundReceivedTerminalWorkInput = {
	env: InboundMailboxEnv
	userId: string
	messageId: string
	deliveryId: string
	expectedFinalizationToken?: string
	durationMs?: number
	ctx?: ExecutionContext
	logLabel: string
}

export type InboundRejectedTerminalWorkInput = {
	env: InboundMailboxEnv
	userId: string
	deliveryId: string
	ctx?: ExecutionContext
}

/**
 * One ordered received-terminal task:
 * 1) bounded full message graph mirror (never throws)
 * 2) D1 inbound delivery effects
 * 3) on effects success only, mirror the updated delivery event
 *
 * Attach to `ctx.waitUntil` when present; otherwise await. Catch/log once so
 * Mailbox/effects failures never throw into Email Routing.
 * `system:email` is skipped (caller keeps the effects-only system path).
 */
export async function scheduleInboundReceivedTerminalWork(
	input: InboundReceivedTerminalWorkInput,
) {
	if (isSystemEmailOwner(input.userId)) return

	const nestedWaitUntil = input.ctx
		? (promise: Promise<unknown>) => {
				input.ctx!.waitUntil(promise)
			}
		: undefined

	const task = (async () => {
		await mirrorMailboxMessageGraphFromD1({
			env: input.env,
			db: input.env.APP_DB,
			userId: input.userId,
			messageId: input.messageId,
		})
		await processInboundDeliveryEffects({
			env: input.env,
			userId: input.userId,
			deliveryId: input.deliveryId,
			expectedFinalizationToken: input.expectedFinalizationToken,
			durationMs: input.durationMs,
			waitUntil: nestedWaitUntil,
		})
		await mirrorMailboxDeliveryEventFromD1({
			env: input.env,
			db: input.env.APP_DB,
			userId: input.userId,
			eventId: input.deliveryId,
		})
	})().catch((error: unknown) => {
		console.error(input.logLabel, error)
	})

	if (input.ctx) {
		input.ctx.waitUntil(task)
		return
	}
	await task
}

/**
 * Rejected-terminal delivery-event mirror only (no message graph).
 * `system:email` is skipped. Never throws into Email Routing.
 */
export async function scheduleInboundRejectedTerminalWork(
	input: InboundRejectedTerminalWorkInput,
) {
	if (isSystemEmailOwner(input.userId)) return

	const task = mirrorMailboxDeliveryEventFromD1({
		env: input.env,
		db: input.env.APP_DB,
		userId: input.userId,
		eventId: input.deliveryId,
	})

	if (input.ctx) {
		input.ctx.waitUntil(task)
		return
	}
	await task
}
