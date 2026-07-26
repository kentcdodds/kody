import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

const forbidden =
	/package_runtime_runs|package_runtime_logs|webhook_deliveries|run_history_json/g

test('production worker sources do not reference dropped run-history legacy', () => {
	const workerSrcRoot = fileURLToPath(new URL('.', import.meta.url))
	const offenders: Array<string> = []

	function walk(dir: string) {
		for (const entry of readdirSync(dir)) {
			const fullPath = join(dir, entry)
			const stat = statSync(fullPath)
			if (stat.isDirectory()) {
				if (
					entry === 'node_modules' ||
					entry === 'dist' ||
					entry === '.wrangler'
				) {
					continue
				}
				walk(fullPath)
				continue
			}
			if (!entry.endsWith('.ts')) continue
			if (entry.endsWith('.test.ts') || entry.endsWith('.workers.test.ts')) {
				continue
			}
			const relativePath = relative(workerSrcRoot, fullPath).replaceAll(
				'\\',
				'/',
			)
			const source = readFileSync(fullPath, 'utf8')
			forbidden.lastIndex = 0
			let match: RegExpExecArray | null
			while ((match = forbidden.exec(source)) !== null) {
				offenders.push(`${relativePath}: ${match[0]}`)
			}
		}
	}

	walk(workerSrcRoot)

	expect(
		offenders,
		'Dropped D1 run-history leftovers must not return in production sources',
	).toEqual([])
})
