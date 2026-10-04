import { describe, expect, test } from 'vitest'
import {
	connectionProfileAllows,
	connectionProfileRevealsResource,
} from '#universal/connection-profiles/grants.ts'
import {
	connectionProfilesFlagKey,
	featureFlagDefinitions,
} from '#universal/feature-flags/registry.ts'

describe('connection profile access contract', () => {
	test('flag key is experiments_opt_in by default', () => {
		const definition = featureFlagDefinitions.find(
			(entry) => entry.key === connectionProfilesFlagKey,
		)
		expect(definition).toBeTruthy()
		expect(definition?.defaultEnabled).toBe(false)
		expect(definition?.defaultAudience).toBe('experiments_opt_in')
	})

	test('absent profile grants are unlimited; empty named profile denies', () => {
		expect(
			connectionProfileAllows({
				grants: null,
				resourceType: 'package',
				resourceId: 'a',
				action: 'execute',
			}),
		).toBe(true)
		expect(
			connectionProfileRevealsResource({
				grants: [],
				resourceType: 'package',
				resourceId: 'a',
			}),
		).toBe(false)
		expect(
			connectionProfileAllows({
				grants: [
					{ resourceType: 'package', resourceId: 'a', actions: ['execute'] },
				],
				resourceType: 'package',
				resourceId: 'a',
				action: 'execute',
			}),
		).toBe(true)
		expect(
			connectionProfileAllows({
				grants: [
					{ resourceType: 'package', resourceId: 'a', actions: ['execute'] },
				],
				resourceType: 'package',
				resourceId: 'b',
				action: 'execute',
			}),
		).toBe(false)
	})
})
