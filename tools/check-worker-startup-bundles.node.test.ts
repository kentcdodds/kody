import { expect, test } from 'vitest'
import {
	readStartupBundleBudget,
	startupBundles,
} from './check-worker-startup-bundles.ts'

test('bundle budget file names every checked worker with a positive ceiling', async () => {
	const budget = await readStartupBundleBudget()
	expect(startupBundles.map((spec) => spec.name)).toEqual([
		'origin',
		'platform',
		'runtime',
	])
	for (const spec of startupBundles) {
		expect(budget[spec.name]).toBeGreaterThan(0)
	}
})
