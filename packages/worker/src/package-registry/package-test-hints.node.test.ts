import { expect, test } from 'vitest'
import { buildPackageTestHints } from './package-test-hints.ts'

test('buildPackageTestHints includes agent-directed enablementEnable calls', () => {
	const hints = buildPackageTestHints({
		packageId: 'pkg-1',
		kodyId: '@noah/mc',
		hasApp: false,
		subscriptionTopics: [],
		enablementTriggers: [
			{ kind: 'cron', name: 'inbox-refresh', reason: 'missing' },
			{ kind: 'subscription', name: 'desk.tick', reason: 'paused' },
		],
	})
	expect(hints).toEqual({
		enablements: {
			message: [
				'Ask the user whether to turn these triggers on for them (publishing never turns triggers on):',
				'- cron "inbox-refresh": ask the user whether to enable it with enablementEnable({ packageId: "pkg-1", triggerKind: "cron", triggerName: "inbox-refresh" }).',
				'- subscription "desk.tick" (paused): ask the user to fix the pause, or re-enable with enablementEnable({ packageId: "pkg-1", triggerKind: "subscription", triggerName: "desk.tick" }).',
			].join('\n'),
			triggers: [
				{
					kind: 'cron',
					name: 'inbox-refresh',
					reason: 'missing',
					call: 'enablementEnable({ packageId: "pkg-1", triggerKind: "cron", triggerName: "inbox-refresh" })',
				},
				{
					kind: 'subscription',
					name: 'desk.tick',
					reason: 'paused',
					call: 'enablementEnable({ packageId: "pkg-1", triggerKind: "subscription", triggerName: "desk.tick" })',
				},
			],
		},
	})
})

test('buildPackageTestHints omits enablementEnable for Approve-only triggers', () => {
	const hints = buildPackageTestHints({
		packageId: 'pkg-1',
		hasApp: false,
		subscriptionTopics: [],
		enablementTriggers: [
			{ kind: 'webhook', name: 'stripe', reason: 'missing' },
			{
				kind: 'subscription',
				name: 'email.message.received',
				reason: 'missing',
			},
		],
	})
	expect(hints?.enablements?.triggers).toEqual([
		{ kind: 'webhook', name: 'stripe', reason: 'missing', call: null },
		{
			kind: 'subscription',
			name: 'email.message.received',
			reason: 'missing',
			call: null,
		},
	])
	expect(hints?.enablements?.message).toContain('Approve')
})
