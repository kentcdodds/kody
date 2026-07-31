import { expect, test } from 'vitest'
import { staticFirstInvocationCodemod } from './0002-static-first-invocation.ts'

function manifest(name = '@user/demo', kodyId = 'demo') {
	return `${JSON.stringify(
		{
			name,
			exports: { '.': './index.ts' },
			kody: {
				id: kodyId,
				description: 'Demo package for static-first invocation codemod tests.',
			},
		},
		null,
		'\t',
	)}\n`
}

test('0002 rewrites invokeChecked member calls and leaves non-targets alone', () => {
	const files = {
		'package.json': manifest(),
		'index.ts': [
			"import { packages } from 'kody:runtime'",
			'',
			'export default async function run() {',
			"\tconst direct = await packages.invokeChecked({ kodyId: 'github', exportName: './request', params: {} })",
			"\tconst optional = await packages?.invokeChecked({ kodyId: 'github', exportName: './request', params: {} })",
			'\treturn { direct, optional }',
			'}',
			'',
		].join('\n'),
	}

	const findings = staticFirstInvocationCodemod.detect(files)
	expect(findings).toEqual([
		{
			path: 'index.ts',
			message: expect.stringContaining('`packages.invokeChecked`'),
		},
	])

	const result = staticFirstInvocationCodemod.transform(files)
	expect(result.changed).toBe(true)
	expect(result.changedPaths).toEqual(['index.ts'])
	expect(result.needsManual).toEqual([])
	expect(result.files['index.ts']).toContain(
		"await packages.invoke({ kodyId: 'github'",
	)
	expect(result.files['index.ts']).toContain(
		"await packages?.invoke({ kodyId: 'github'",
	)
	expect(result.files['index.ts']).not.toContain('invokeChecked')

	const rerun = staticFirstInvocationCodemod.transform(result.files)
	expect(rerun.changed).toBe(false)
	expect(rerun.files).toEqual(result.files)

	const untouched = {
		'package.json': manifest(),
		'README.md':
			'Historical note: `packages.invokeChecked` used to be the recommendation.\n',
		'index.ts': [
			'const other = { invokeChecked: () => 1 }',
			'export default async function run() {',
			'\treturn other.invokeChecked()',
			'}',
			'',
		].join('\n'),
	}
	expect(staticFirstInvocationCodemod.detect(untouched)).toEqual([])
	const untouchedResult = staticFirstInvocationCodemod.transform(untouched)
	expect(untouchedResult.changed).toBe(false)
	expect(untouchedResult.files).toEqual(untouched)
})

test('0002 reports needsManual for check/dynamic imports, parse failures, and mixed packages', () => {
	const manualFiles = {
		'package.json': manifest(),
		'index.ts': [
			"import { packages } from 'kody:runtime'",
			'',
			'export default async function run() {',
			"\tconst contract = await packages.check({ kodyId: 'github', exportName: './request' })",
			"\tconst dynamicModule = await import('kody:@kentcdodds/github/request')",
			'\treturn { contract, dynamicType: typeof dynamicModule.default }',
			'}',
			'',
		].join('\n'),
	}
	const manualResult = staticFirstInvocationCodemod.transform(manualFiles)
	expect(manualResult.changed).toBe(false)
	expect(manualResult.needsManual).toEqual([
		{
			path: 'index.ts',
			message: expect.stringContaining('literal dynamic `import("kody:@...")`'),
		},
		{
			path: 'index.ts',
			message: expect.stringContaining('`packages.check`'),
		},
	])

	const brokenFiles = {
		'package.json': manifest(),
		'broken.ts': [
			"import { packages } from 'kody:runtime'",
			'export default async function run( {', // malformed on purpose
			"\treturn await packages.invokeChecked({ kodyId: 'github', exportName: './request' })",
			'}',
			'',
		].join('\n'),
	}
	const brokenResult = staticFirstInvocationCodemod.transform(brokenFiles)
	expect(brokenResult.changed).toBe(false)
	expect(brokenResult.needsManual).toEqual([
		{
			path: 'broken.ts',
			message: expect.stringContaining('could not be parsed'),
		},
	])

	const mixedFiles = {
		'package.json': manifest(),
		'auto.ts': [
			"import { packages } from 'kody:runtime'",
			'export default async function auto() {',
			"\treturn await packages.invokeChecked({ kodyId: 'skills', exportName: './skill-get', params: { id: 'x' } })",
			'}',
			'',
		].join('\n'),
		'manual.ts': [
			"import { packages } from 'kody:runtime'",
			'export default async function manual() {',
			"\treturn await packages.check({ kodyId: 'skills', exportName: './skill-get' })",
			'}',
			'',
		].join('\n'),
	}
	const mixedResult = staticFirstInvocationCodemod.transform(mixedFiles)
	expect(mixedResult.changed).toBe(true)
	expect(mixedResult.changedPaths).toEqual(['auto.ts'])
	expect(mixedResult.files['auto.ts']).toContain('packages.invoke({')
	expect(mixedResult.files['auto.ts']).not.toContain('invokeChecked')
	expect(mixedResult.files['manual.ts']).toBe(mixedFiles['manual.ts'])
	expect(mixedResult.needsManual).toEqual([
		{
			path: 'manual.ts',
			message: expect.stringContaining('`packages.check`'),
		},
	])
})
