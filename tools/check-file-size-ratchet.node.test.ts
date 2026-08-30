import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import {
	checkFileSizeRatchet,
	countLines,
	parseFileSizeRatchetSnapshot,
	type FileSizeRatchetSnapshot,
} from './check-file-size-ratchet.ts'

function lines(count: number) {
	return Array.from(
		{ length: count },
		(_, index) => `line-${String(index)}`,
	).join('\n')
}

test('countLines treats a trailing newline as one terminator, not an extra line', () => {
	expect(countLines('')).toBe(0)
	expect(countLines('one\n')).toBe(1)
	expect(countLines('one\ntwo\n')).toBe(2)
	expect(countLines(lines(800))).toBe(800)
})

test('parseFileSizeRatchetSnapshot rejects a malformed snapshot', () => {
	expect(() => parseFileSizeRatchetSnapshot('[]')).toThrow(/must be an object/)
	expect(() => parseFileSizeRatchetSnapshot('{"client-routes":[]}')).toThrow(
		/node-tests/,
	)
})

test('checkFileSizeRatchet allows grandfathered files and rejects new over-budget files', async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), 'file-size-ratchet-'))
	try {
		const routesDir = path.join(cwd, 'packages', 'worker', 'client', 'routes')
		const testsDir = path.join(cwd, 'packages', 'worker', 'src')
		await Promise.all([
			mkdir(routesDir, { recursive: true }),
			mkdir(testsDir, { recursive: true }),
		])
		await Promise.all([
			writeFile(path.join(routesDir, 'small.tsx'), `${lines(10)}\n`),
			writeFile(path.join(routesDir, 'legacy.tsx'), `${lines(900)}\n`),
			writeFile(path.join(routesDir, 'new-large.tsx'), `${lines(801)}\n`),
			writeFile(path.join(testsDir, 'legacy.node.test.ts'), `${lines(2500)}\n`),
			writeFile(
				path.join(testsDir, 'new-large.node.test.ts'),
				`${lines(2001)}\n`,
			),
			writeFile(path.join(testsDir, 'gone.node.test.ts'), `${lines(10)}\n`),
		])

		const snapshot: FileSizeRatchetSnapshot = {
			'client-routes': ['packages/worker/client/routes/legacy.tsx'],
			'node-tests': [
				'packages/worker/src/legacy.node.test.ts',
				'packages/worker/src/missing.node.test.ts',
			],
		}

		const result = await checkFileSizeRatchet(cwd, snapshot)
		expect(result.ok).toBe(false)
		expect(result.issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					file: 'packages/worker/client/routes/new-large.tsx',
					kind: 'new-over-budget',
					lineCount: 801,
					maxLines: 800,
				}),
				expect.objectContaining({
					file: 'packages/worker/src/new-large.node.test.ts',
					kind: 'new-over-budget',
					lineCount: 2001,
					maxLines: 2000,
				}),
				expect.objectContaining({
					file: 'packages/worker/src/missing.node.test.ts',
					kind: 'stale-snapshot',
				}),
			]),
		)
		expect(result.issues).not.toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					file: 'packages/worker/client/routes/legacy.tsx',
				}),
				expect.objectContaining({
					file: 'packages/worker/src/legacy.node.test.ts',
					kind: 'new-over-budget',
				}),
			]),
		)
	} finally {
		await rm(cwd, { recursive: true, force: true })
	}
})
