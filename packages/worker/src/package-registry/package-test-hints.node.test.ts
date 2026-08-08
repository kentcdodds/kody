import { expect, test } from 'vitest'
import { buildPackageTestHints } from './package-test-hints.ts'

test('buildPackageTestHints returns only hints for declared package surfaces', () => {
	expect(
		buildPackageTestHints({
			kodyId: 'demo',
			hasApp: false,
			subscriptionTopics: [],
		}),
	).toBeUndefined()

	expect(
		buildPackageTestHints({
			kodyId: 'demo',
			hasApp: true,
			subscriptionTopics: [],
		}),
	).toEqual({
		app: 'package_app_fetch({ kody_id: "demo" })',
	})

	expect(
		buildPackageTestHints({
			kodyId: 'demo',
			hasApp: false,
			subscriptionTopics: ['repo.pushed', 'email.message.received'],
		}),
	).toEqual({
		subscriptions: [
			{
				topic: 'email.message.received',
				snippet:
					'package_subscription_dispatch({ kody_id: "demo", topic: "email.message.received", params: {} })',
			},
			{
				topic: 'repo.pushed',
				snippet:
					'package_subscription_dispatch({ kody_id: "demo", topic: "repo.pushed", params: {} })',
			},
		],
	})

	expect(
		buildPackageTestHints({
			kodyId: 'demo',
			hasApp: true,
			subscriptionTopics: ['repo.pushed'],
			packageScope: 'platform',
		}),
	).toEqual({
		app: 'package_app_fetch({ kody_id: "demo", package_scope: "platform" })',
		subscriptions: [
			{
				topic: 'repo.pushed',
				snippet:
					'package_subscription_dispatch({ kody_id: "demo", package_scope: "platform", topic: "repo.pushed", params: {} })',
			},
		],
	})
})
