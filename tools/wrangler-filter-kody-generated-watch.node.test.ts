import { expect, test } from 'vitest'
import {
	ensureWranglerFiltersKodyGeneratedWatch,
	wranglerAdditionalModuleWatchSource,
	wranglerCliPath,
} from './wrangler-filter-kody-generated-watch.ts'
import { readFile } from 'node:fs/promises'

test('wrangler still assigns additional-module watchFiles from discovered paths', async () => {
	const source = await readFile(wranglerCliPath, 'utf8')
	expect(
		source.includes('watchFiles = foundModulePaths;') ||
			source.includes(
				'watchFiles = foundModulePaths.filter((p) => !p.includes(".kody-generated"));',
			),
	).toBe(true)
})

test('the watch filter skips .kody-generated paths and is idempotent', async () => {
	const unpatched = [
		'if (props.findAdditionalModules) {',
		'\t\t\t\t\t\t\t\t\t\t\t\t\twatchFiles = foundModulePaths;',
		'\t\t\t\t\t\t\t\t\t\t\t\t\tconst root = path31__namespace.default.resolve(props.entry.moduleRoot);',
	].join('\n')
	const first = wranglerAdditionalModuleWatchSource(unpatched)
	expect(first.changed).toBe(true)
	expect(first.source.includes('.kody-generated')).toBe(true)
	const second = wranglerAdditionalModuleWatchSource(first.source)
	expect(second.changed).toBe(false)
	expect(second.source).toBe(first.source)

	const applied = await ensureWranglerFiltersKodyGeneratedWatch()
	expect(applied.patched).toBe(true)
	const disk = await readFile(wranglerCliPath, 'utf8')
	expect(
		disk.includes(
			'watchFiles = foundModulePaths.filter((p) => !p.includes(".kody-generated"));',
		),
	).toBe(true)
})
