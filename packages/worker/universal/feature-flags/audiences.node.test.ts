import { expect, test } from 'vitest'
import {
	defaultFeatureFlagAudience,
	featureFlagAudiences,
	isFeatureFlagAudience,
} from './audiences.ts'

test('feature flag audiences are everyone and experiments_opt_in', () => {
	expect(featureFlagAudiences).toEqual(['everyone', 'experiments_opt_in'])
	expect(defaultFeatureFlagAudience).toBe('everyone')
	expect(isFeatureFlagAudience('everyone')).toBe(true)
	expect(isFeatureFlagAudience('experiments_opt_in')).toBe(true)
	expect(isFeatureFlagAudience('plans')).toBe(false)
	expect(isFeatureFlagAudience(null)).toBe(false)
})
