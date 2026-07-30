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

test('0002 rewrites invokeChecked member calls (including optional chaining) to invoke', () => {
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

	// Idempotent: rerunning on the transformed tree changes nothing.
	const rerun = staticFirstInvocationCodemod.transform(result.files)
	expect(rerun.changed).toBe(false)
	expect(rerun.changedPaths).toEqual([])
	expect(rerun.files).toEqual(result.files)
})

test('0002 leaves unrelated invokeChecked identifiers and non-code files alone', () => {
	const files = {
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

	expect(staticFirstInvocationCodemod.detect(files)).toEqual([])
	const result = staticFirstInvocationCodemod.transform(files)
	expect(result.changed).toBe(false)
	expect(result.changedPaths).toEqual([])
	expect(result.needsManual).toEqual([])
	expect(result.files).toEqual(files)
})

test('0002 reports packages.check and literal dynamic kody imports as needsManual', () => {
	const files = {
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

	const findings = staticFirstInvocationCodemod.detect(files)
	expect(findings).toEqual([
		{
			path: 'index.ts',
			message: expect.stringContaining('literal dynamic `import("kody:@...")`'),
		},
		{
			path: 'index.ts',
			message: expect.stringContaining('`packages.check`'),
		},
	])

	const result = staticFirstInvocationCodemod.transform(files)
	expect(result.changed).toBe(false)
	expect(result.changedPaths).toEqual([])
	expect(result.files).toEqual(files)
	expect(result.needsManual).toEqual([
		{
			path: 'index.ts',
			message: expect.stringContaining('literal dynamic `import("kody:@...")`'),
		},
		{
			path: 'index.ts',
			message: expect.stringContaining('`packages.check`'),
		},
	])
})

test('0002 flags unparseable files that reference the deprecated surface', () => {
	const files = {
		'package.json': manifest(),
		'broken.ts': [
			"import { packages } from 'kody:runtime'",
			'export default async function run( {', // malformed on purpose
			"\treturn await packages.invokeChecked({ kodyId: 'github', exportName: './request' })",
			'}',
			'',
		].join('\n'),
	}

	const findings = staticFirstInvocationCodemod.detect(files)
	expect(findings).toEqual([
		{
			path: 'broken.ts',
			message: expect.stringContaining('could not be parsed'),
		},
	])

	const result = staticFirstInvocationCodemod.transform(files)
	expect(result.changed).toBe(false)
	expect(result.changedPaths).toEqual([])
	expect(result.files).toEqual(files)
	expect(result.needsManual).toEqual([
		{
			path: 'broken.ts',
			message: expect.stringContaining('could not be parsed'),
		},
	])
})

test('0002 mixes mechanical rewrites with needsManual findings in one package', () => {
	const files = {
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

	const result = staticFirstInvocationCodemod.transform(files)
	expect(result.changed).toBe(true)
	expect(result.changedPaths).toEqual(['auto.ts'])
	expect(result.files['auto.ts']).toContain('packages.invoke({')
	expect(result.files['auto.ts']).not.toContain('invokeChecked')
	expect(result.files['manual.ts']).toBe(files['manual.ts'])
	expect(result.needsManual).toEqual([
		{
			path: 'manual.ts',
			message: expect.stringContaining('`packages.check`'),
		},
	])
})
