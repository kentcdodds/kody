import { expect, test } from 'vitest'
import { createStableDynamicWorkerId } from '#mcp/dynamic-worker-id.ts'
import { createDynamicWorkerCompatibilityOptions } from '#worker/dynamic-worker-compatibility.ts'
import { classifyExecuteThinGlue } from '#worker/usage/execute-thin-glue.ts'
import {
	buildExecuteInvokePassthroughSource,
	executeInvokeUnsupportedSpecifierMessage,
	parseExecuteInvokeSpecifier,
	resolveExecuteInvokeCode,
	resolveExecuteModuleSource,
} from './execute-invoke.ts'

const handwrittenThinPassthrough = `import action from "kody:@acme/github/listRepos"

export default async function main(params) {
	return await action(params)
}`

async function mintIdForSource(source: string) {
	return await createStableDynamicWorkerId({
		userId: 'user-1',
		storageContext: null,
		workerOptions: {
			...createDynamicWorkerCompatibilityOptions(),
			mainModule: 'index.js',
			modules: { 'index.js': source },
		},
	})
}

test('parseExecuteInvokeSpecifier accepts kody:@ and hash forms and rejects URLs', () => {
	expect(parseExecuteInvokeSpecifier('kody:@acme/github/listRepos')).toBe(
		'kody:@acme/github/listRepos',
	)
	expect(parseExecuteInvokeSpecifier('  @acme/github/listRepos  ')).toBe(
		'kody:@acme/github/listRepos',
	)
	expect(parseExecuteInvokeSpecifier('kody:@acme/github#listRepos')).toBe(
		'kody:@acme/github/listRepos',
	)
	expect(parseExecuteInvokeSpecifier('@acme/github#./listRepos')).toBe(
		'kody:@acme/github/listRepos',
	)
	expect(parseExecuteInvokeSpecifier('kody:@acme/github')).toBe(
		'kody:@acme/github',
	)
	expect(parseExecuteInvokeSpecifier('@acme/github#.')).toBe(
		'kody:@acme/github',
	)

	expect(() => parseExecuteInvokeSpecifier('https://example.com/pkg')).toThrow(
		executeInvokeUnsupportedSpecifierMessage,
	)
	expect(() => parseExecuteInvokeSpecifier('github.com/acme/pkg')).toThrow(
		executeInvokeUnsupportedSpecifierMessage,
	)
	expect(() => parseExecuteInvokeSpecifier('kody:runtime')).toThrow(
		executeInvokeUnsupportedSpecifierMessage,
	)
	expect(() => parseExecuteInvokeSpecifier('kody:@acme')).toThrow(
		executeInvokeUnsupportedSpecifierMessage,
	)
	expect(() => parseExecuteInvokeSpecifier('')).toThrow(
		executeInvokeUnsupportedSpecifierMessage,
	)
})

test('invoke codegen is the same thin passthrough a careful agent writes', async () => {
	const generated = resolveExecuteInvokeCode('@acme/github#listRepos')
	expect(generated).toBe(handwrittenThinPassthrough)
	expect(generated).toBe(
		buildExecuteInvokePassthroughSource('kody:@acme/github/listRepos'),
	)
	expect(classifyExecuteThinGlue(generated)).toBe('thin_single_export')
	expect(classifyExecuteThinGlue(handwrittenThinPassthrough)).toBe(
		'thin_single_export',
	)

	const invokeId = await mintIdForSource(generated)
	const handwrittenId = await mintIdForSource(handwrittenThinPassthrough)
	expect(invokeId).toBe(handwrittenId)
	expect(invokeId.startsWith('kody-')).toBe(true)
})

test('resolveExecuteModuleSource enforces flag gating and mutual exclusion', () => {
	expect(() =>
		resolveExecuteModuleSource({
			invoke: 'kody:@acme/github/listRepos',
			invokeEnabled: false,
		}),
	).toThrow(/execute invoke is an experiment/)
	expect(() =>
		resolveExecuteModuleSource({
			code: 'export default async function main() { return 1 }',
			invoke: 'kody:@acme/github/listRepos',
			invokeEnabled: true,
		}),
	).toThrow(/either code or invoke/)
	expect(() =>
		resolveExecuteModuleSource({
			invokeEnabled: true,
		}),
	).toThrow(/requires code or invoke/)
	expect(
		resolveExecuteModuleSource({
			code: 'export default async function main() { return 1 }',
			invokeEnabled: false,
		}),
	).toBe('export default async function main() { return 1 }')
	expect(
		resolveExecuteModuleSource({
			invoke: 'kody:@acme/github/listRepos',
			invokeEnabled: true,
		}),
	).toBe(handwrittenThinPassthrough)
})
