import { expect, test } from 'vitest'
import {
	featureFlagDefinitions,
	getFeatureFlagDefinition,
	isFeatureFlagKey,
	measuredFeatureFlagKeys,
} from './registry.ts'

test('mailbox-read-cutover is registered default-off with email_received success metric', () => {
	expect(isFeatureFlagKey('mailbox-read-cutover')).toBe(true)
	const definition = getFeatureFlagDefinition('mailbox-read-cutover')
	expect(definition).toMatchObject({
		key: 'mailbox-read-cutover',
		defaultEnabled: false,
		successMetric: {
			eventType: 'email_received',
			measure: 'error_rate',
			goal: 'decrease',
		},
	})
	expect(definition.description.length).toBeGreaterThan(0)
	expect(measuredFeatureFlagKeys.has('mailbox-read-cutover')).toBe(true)
	expect(
		featureFlagDefinitions.some((flag) => flag.key === 'mailbox-read-cutover'),
	).toBe(true)
})
