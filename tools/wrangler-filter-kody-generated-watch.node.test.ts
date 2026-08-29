import { expect, test } from 'vitest'
import {
	ensureWranglerFiltersKodyGeneratedWatch,
	wranglerAdditionalModuleWatchSource,
	wranglerCliPath,
} from './wrangler-filter-kody-generated-watch.ts'
import { readFile } from 'node:fs/promises'

const wrangler4127WatchBlock = `if (props.findAdditionalModules) {
              watchFiles = foundModulePaths;
              const root = path31__namespace.default.resolve(props.entry.moduleRoot);
              for await (const dir6 of findAdditionalModuleWatchDirs(root)) {
                watchDirs.push(dir6);
              }
            }`

const wrangler4120WatchBlock = `if (props.findAdditionalModules) {
              watchFiles = foundModulePaths;
              const root = path31__namespace.default.resolve(props.entry.moduleRoot);
              for await (const dir5 of findAdditionalModuleWatchDirs(root)) {
                watchDirs.push(dir5);
              }
            }`

test('the additional-module watch filter is idempotent and marked', () => {
	for (const upstreamWatchBlock of [
		wrangler4127WatchBlock,
		wrangler4120WatchBlock,
	]) {
		const first = wranglerAdditionalModuleWatchSource(upstreamWatchBlock)
		expect(first.changed).toBe(true)
		expect(first.source.includes('kody-1789')).toBe(true)
		expect(first.source.includes('watchFiles = foundModulePaths;')).toBe(false)
		const second = wranglerAdditionalModuleWatchSource(first.source)
		expect(second.changed).toBe(false)
		expect(second.source).toBe(first.source)
	}
})

test('ensureWranglerFiltersKodyGeneratedWatch patches the installed wrangler CLI', async () => {
	const applied = await ensureWranglerFiltersKodyGeneratedWatch()
	expect(applied.patched).toBe(true)
	const disk = await readFile(wranglerCliPath, 'utf8')
	expect(disk.includes('kody-1789')).toBe(true)
	expect(disk.includes('watchFiles = foundModulePaths;')).toBe(false)
})
