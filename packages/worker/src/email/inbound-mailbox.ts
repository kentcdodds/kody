import { isSystemEmailOwner } from './email-owner.ts'
import { createUserInboundDeliveryAuthority } from './inbound-delivery-authority.ts'
import { processInboundDeliveryEffects } from './inbound-effects.ts'
import {
	mirrorMailboxMessageGraphFromD1,
	type MailboxLiveMirrorEnv,
} from './mailbox-live-mirror.ts'
import { type EmailReportingEnv } from './reporting-events.ts'

/**
 * Env surface for inbound Mailbox terminal coordination.
 * Mailbox owns USER inbound delivery state; D1 is a synchronous compatibility
 * snapshot used by graph fences and scheduled owner discovery.
 */
export type InboundMailboxEnv = Pick<
	Env,
	| 'APP_DB'
	| 'BUNDLE_ARTIFACTS_KV'
	| 'APP_BASE_URL'
	| 'USAGE_EVENTS'
	| 'USER_METER'
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
 * 2) Mailbox-authoritative inbound delivery effects
 * 3) final Mailbox → D1 delivery snapshot repair
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
			includeDeliveryEvents: false,
		})
		await processInboundDeliveryEffects({
			env: input.env,
			userId: input.userId,
			deliveryId: input.deliveryId,
			expectedFinalizationToken: input.expectedFinalizationToken,
			durationMs: input.durationMs,
			waitUntil: nestedWaitUntil,
		})
		const authority = createUserInboundDeliveryAuthority({
			env: input.env,
			userId: input.userId,
		})
		await authority.get(input.deliveryId)
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
 * Rejected-terminal Mailbox → D1 snapshot repair only (no message graph).
 * `system:email` is skipped. Never throws into Email Routing.
 */
export async function scheduleInboundRejectedTerminalWork(
	input: InboundRejectedTerminalWorkInput,
) {
	if (isSystemEmailOwner(input.userId)) return

	const task = Promise.resolve()
		.then(async () => {
			const authority = createUserInboundDeliveryAuthority({
				env: input.env,
				userId: input.userId,
			})
			await authority.get(input.deliveryId)
		})
		.catch((error: unknown) => {
			console.error('Inbound email rejection projection repair failed', error)
		})

	if (input.ctx) {
		input.ctx.waitUntil(task)
		return
	}
	await task
}
