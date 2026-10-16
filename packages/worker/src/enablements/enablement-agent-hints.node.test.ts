import { expect, test } from 'vitest'
import {
	buildMultiTriggerEnablementHint,
	buildNoEnablementSkipError,
	buildSingleTriggerEnablementHint,
	formatEnablementEnableCall,
} from './enablement-agent-hints.ts'

test('formatEnablementEnableCall prefers packageId and quotes names', () => {
	expect(
		formatEnablementEnableCall({
			packageId: 'pkg-1',
			kodyId: '@noah/mc',
			triggerKind: 'cron',
			triggerName: 'inbox-refresh',
		}),
	).toBe(
		'enablementEnable({ packageId: "pkg-1", triggerKind: "cron", triggerName: "inbox-refresh" })',
	)
	expect(
		formatEnablementEnableCall({
			kodyId: '@noah/mc',
			triggerKind: 'subscription',
			triggerName: 'desk.tick',
		}),
	).toBe(
		'enablementEnable({ kodyId: "@noah/mc", triggerKind: "subscription", triggerName: "desk.tick" })',
	)
})

test('single-trigger cron hints do not ask about owner-created jobs; other triggers still ask', () => {
	expect(
		buildSingleTriggerEnablementHint({
			packageId: 'pkg-1',
			triggerKind: 'cron',
			triggerName: 'inbox-refresh',
			reason: 'missing',
		}),
	).toBe(
		'Call enablementEnable({ packageId: "pkg-1", triggerKind: "cron", triggerName: "inbox-refresh" }) to turn on cron "inbox-refresh" for the owner. Creating a job enables it for the owner automatically; other package triggers still need an explicit enable.',
	)
	expect(
		buildSingleTriggerEnablementHint({
			packageId: 'pkg-1',
			triggerKind: 'cron',
			triggerName: 'inbox-refresh',
			reason: 'paused',
		}),
	).toBe(
		'Ask the user to fix the paused enablement for cron "inbox-refresh", or re-enable with enablementEnable({ packageId: "pkg-1", triggerKind: "cron", triggerName: "inbox-refresh" }).',
	)
	expect(
		buildSingleTriggerEnablementHint({
			packageId: 'pkg-1',
			triggerKind: 'webhook',
			triggerName: 'stripe',
			reason: 'missing',
		}),
	).toContain('Ask the user whether to turn on webhook "stripe"')
	expect(
		buildSingleTriggerEnablementHint({
			packageId: 'pkg-1',
			triggerKind: 'subscription',
			triggerName: 'email.message.received',
			reason: 'missing',
		}),
	).toContain('Approve from the inbox')
	expect(
		buildSingleTriggerEnablementHint({
			packageId: 'pkg-1',
			triggerKind: 'subscription',
			triggerName: 'desk.tick',
			reason: 'missing',
		}),
	).toBe(
		'Ask the user whether to enable subscription "desk.tick" for them: enablementEnable({ packageId: "pkg-1", triggerKind: "subscription", triggerName: "desk.tick" }). Publishing never turns a trigger on.',
	)
	expect(
		buildSingleTriggerEnablementHint({
			packageId: 'pkg-1',
			triggerKind: 'cron',
			triggerName: 'email.message.received',
			reason: 'missing',
		}),
	).toContain('triggerKind: "cron"')
	expect(
		buildSingleTriggerEnablementHint({
			packageId: 'pkg-1',
			triggerKind: 'cron',
			triggerName: 'email.message.received',
			reason: 'missing',
		}),
	).not.toContain('Approve from the inbox')
})

test('multi-trigger publish hint lists each enablementEnable call', () => {
	const message = buildMultiTriggerEnablementHint({
		packageId: 'pkg-1',
		kodyId: '@noah/mc',
		triggers: [
			{ kind: 'cron', name: 'inbox-refresh', reason: 'missing' },
			{ kind: 'subscription', name: 'desk.tick', reason: 'paused' },
			{ kind: 'webhook', name: 'stripe', reason: 'missing' },
		],
	})
	expect(message).toContain(
		'Ask the user whether to turn these triggers on for them (publishing does not auto-enable webhooks or subscriptions; new package jobs enable for the owner on create):',
	)
	expect(message).toContain(
		'enablementEnable({ packageId: "pkg-1", triggerKind: "cron", triggerName: "inbox-refresh" })',
	)
	expect(message).toContain(
		'enablementEnable({ packageId: "pkg-1", triggerKind: "subscription", triggerName: "desk.tick" })',
	)
	expect(message).toContain('webhook "stripe"')
	expect(message).toContain(
		'ask the user whether to Approve it (enablementEnable cannot turn a webhook on the first time).',
	)
})

test('skip errors reuse the cron owner enablementEnable guidance', () => {
	expect(
		buildNoEnablementSkipError({
			packageId: 'pkg-1',
			jobName: 'inbox-refresh',
			reason: 'missing',
		}),
	).toBe(
		'Scheduled tick skipped: no on enablement for cron "inbox-refresh". Call enablementEnable({ packageId: "pkg-1", triggerKind: "cron", triggerName: "inbox-refresh" }) to turn on cron "inbox-refresh" for the owner. Creating a job enables it for the owner automatically; other package triggers still need an explicit enable.',
	)
	expect(
		buildNoEnablementSkipError({
			packageId: 'pkg-1',
			jobName: 'inbox-refresh',
			reason: 'paused',
		}),
	).toContain('every enablement for cron "inbox-refresh" is paused')
})
