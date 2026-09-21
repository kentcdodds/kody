import { expect, test } from 'vitest'
import { classifyExecuteThinGlue } from '#worker/usage/execute-thin-glue.ts'
import {
	executeInvokeUnsupportedSpecifierMessage,
	parseExecuteInvokeSpecifier,
	resolveExecuteInvokeCode,
	resolveExecuteModuleSource,
} from './execute-invoke.ts'

const handwrittenThinPassthrough = `import action from "kody:@acme/github/listRepos"

export default async function main(params) {
	return await action(params)
}`

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

test('invoke codegen is the same thin passthrough a careful agent writes', () => {
	const generated = resolveExecuteInvokeCode('@acme/github#listRepos')
	expect(generated).toBe(handwrittenThinPassthrough)
	expect(classifyExecuteThinGlue(generated)).toBe('thin_single_export')
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
