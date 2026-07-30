import { expect, test } from 'vitest'
import {
	assertAdHocExecuteTypechecks,
	ExecuteTypecheckError,
} from './execute-typecheck.ts'

test('valid modules pass and report phase timing with the semantic-skipped marker', async () => {
	const serverTiming = await assertAdHocExecuteTypechecks({
		source: `import call from 'kody:@kentcdodds/static-contract'
import { kody, packageStorage } from 'kody:runtime'
import arbitraryClient from 'arbitrary-uninstalled-npm-package'

export default async function run(input: { name: string }) {
	void arbitraryClient
	void kody
	void packageStorage
	const result = await call({ name: input.name })
	return result
}`,
	})
	expect(serverTiming.map((entry) => entry.name)).toEqual([
		'typecheck-semantic-skipped',
		'typecheck-parse',
		'typecheck-total',
	])
	for (const entry of serverTiming) {
		expect(entry.durationMs).toBeGreaterThanOrEqual(0)
	}
	const totalMs = serverTiming.at(-1)!.durationMs
	const phaseSumMs = serverTiming
		.slice(0, -1)
		.reduce((sum, entry) => sum + entry.durationMs, 0)
	expect(totalMs).toBeGreaterThanOrEqual(phaseSumMs - 5)
})

test('syntax errors fail with entry.ts line/column diagnostics and phase timing', async () => {
	const failure = await assertAdHocExecuteTypechecks({
		source: `export default async function run() {
	const value =
}`,
	}).then(
		() => null,
		(error: unknown) => error,
	)
	expect(failure).toBeInstanceOf(ExecuteTypecheckError)
	expect((failure as ExecuteTypecheckError).message).toContain(
		'Ad hoc execute TypeScript check failed:',
	)
	expect((failure as ExecuteTypecheckError).diagnostics).toEqual([
		expect.stringMatching(/^entry\.ts:\d+:\d+ /),
	])
	expect(
		(failure as ExecuteTypecheckError).serverTiming?.map((entry) => entry.name),
	).toEqual([
		'typecheck-semantic-skipped',
		'typecheck-parse',
		'typecheck-total',
	])
})

test('modules without a default export fail with a clear diagnostic', async () => {
	await expect(
		assertAdHocExecuteTypechecks({
			source: 'export function run() {\n\treturn 1\n}',
		}),
	).rejects.toThrow('Module must have a default export')

	// Re-exported defaults satisfy the runtime contract and pass.
	await expect(
		assertAdHocExecuteTypechecks({
			source: "export { default } from './other.ts'",
		}),
	).resolves.toBeDefined()
})

test('rejects oversized source', async () => {
	await expect(
		assertAdHocExecuteTypechecks({
			source: `export default function run() {}\n/*${'x'.repeat(512 * 1024)}*/`,
		}),
	).rejects.toThrow(
		'entry.ts exceeds the 524288-byte pre-execution TypeScript source limit.',
	)
})

test('semantic-only errors are not reported (no compiler runs in the MCP isolate)', async () => {
	// A type-level contract violation the removed LanguageService check would
	// have caught. Semantic checking cannot run inside the MCP isolate (see
	// the execute-typecheck module docstring), so this passes pre-exec.
	await expect(
		assertAdHocExecuteTypechecks({
			source: `export default async function run(): string {
	return 42
}`,
		}),
	).resolves.toBeDefined()
})
