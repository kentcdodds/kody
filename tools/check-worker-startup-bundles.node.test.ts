import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
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
		expect(Number.isSafeInteger(budget[spec.name])).toBe(true)
	}
})

test('bundle budget file rejects non-finite and fractional ceilings', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'startup-bundle-budget-'))
	try {
		const budgetPath = path.join(dir, 'budget.json')
		await writeFile(
			budgetPath,
			JSON.stringify({
				origin: 1,
				platform: Number.POSITIVE_INFINITY,
				runtime: 1,
			}),
		)
		await expect(readStartupBundleBudget(budgetPath)).rejects.toThrow(
			/Invalid startup bundle budget for platform/,
		)
		await writeFile(
			budgetPath,
			JSON.stringify({ origin: 1.5, platform: 1, runtime: 1 }),
		)
		await expect(readStartupBundleBudget(budgetPath)).rejects.toThrow(
			/Invalid startup bundle budget for origin/,
		)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})
