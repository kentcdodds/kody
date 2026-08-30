import { expect, test } from 'vitest'
import {
	heavyWorkOffloadGuideId,
	isolatedRunnerResourceLimitAdvice,
} from './isolated-runner-limit-message.ts'

test('isolate resource-limit advice points at the offload guide', () => {
	const advice = isolatedRunnerResourceLimitAdvice()
	expect(advice).toContain('npm dependency graph')
	expect(advice).toContain(
		`coding_guide_get({ guide: "${heavyWorkOffloadGuideId}" })`,
	)
	expect(advice).not.toContain('Reduce the package source size')
})
