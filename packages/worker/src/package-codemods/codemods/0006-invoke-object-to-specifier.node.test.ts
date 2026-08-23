import { expect, test } from 'vitest'
import { getPackageCodemodById } from '../registry.ts'
import {
	invokeObjectToSpecifierCodemod,
	invokeObjectToSpecifierCodemodId,
} from './0006-invoke-object-to-specifier.ts'

function manifest(name = '@user/demo') {
	return `${JSON.stringify(
		{
			name,
			exports: { '.': './index.ts' },
			kody: {
				id: 'demo',
				description: 'Demo package for invoke specifier codemod tests.',
			},
		},
		null,
		'\t',
	)}\n`
}

test('0006 rewrites safe object-only invokes to owner-scoped string-first calls', () => {
	const files = {
		'package.json': manifest('@kentcdodds/demo'),
		'index.ts': [
			"import { packages } from 'kody:runtime'",
			'',
			'export default async function run(event) {',
			"\tconst direct = await packages.invoke({ kodyId: 'github', exportName: './request', params: { event } })",
			"\tconst optional = await packages?.invoke({ exportName: '.', idempotencyKey: event.id, kodyId: 'inbox' })",
			"\tconst defaultExport = await packages.invoke({ kodyId: 'calendar' })",
			"\tconst paramsOnly = await packages.invoke({ params: { event }, kodyId: 'notify' })",
			'\treturn { direct, optional, defaultExport, paramsOnly }',
			'}',
			'',
		].join('\n'),
		'already-migrated.ts': [
			"import { packages } from 'kody:runtime'",
			"await packages.invoke('kody:@kentcdodds/github/request', { params: {} })",
			"await packages.invoke('kody:@kentcdodds/inbox')",
			'',
		].join('\n'),
	}

	expect(invokeObjectToSpecifierCodemod.detect(files)).toEqual([
		{
			path: 'index.ts',
			message: expect.stringContaining('deprecated object-only'),
		},
	])

	const result = invokeObjectToSpecifierCodemod.transform(files)
	expect(result.changed).toBe(true)
	expect(result.changedPaths).toEqual(['index.ts'])
	expect(result.needsManual).toEqual([])
	expect(result.files['index.ts']).toContain(
		'packages.invoke("kody:@kentcdodds/github", { exportName:',
	)
	expect(result.files['index.ts']).toContain(
		'packages?.invoke("kody:@kentcdodds/inbox", { exportName:',
	)
	expect(result.files['index.ts']).toContain(
		'packages.invoke("kody:@kentcdodds/calendar")',
	)
	expect(result.files['index.ts']).toContain(
		'packages.invoke("kody:@kentcdodds/notify", { params:',
	)
	expect(result.files['index.ts']).not.toContain("kodyId: '")
	expect(result.files['already-migrated.ts']).toBe(files['already-migrated.ts'])

	const rerun = invokeObjectToSpecifierCodemod.transform(result.files)
	expect(rerun.changed).toBe(false)
	expect(rerun.changedPaths).toEqual([])
	expect(rerun.needsManual).toEqual([])
	expect(rerun.files).toEqual(result.files)
})

test('0006 partially migrates safe files and reports ambiguous calls for review', () => {
	const files = {
		'package.json': manifest(),
		'safe.ts':
			"await packages.invoke({ exportName: './run', kodyId: 'worker', topic: 'jobs' })\n",
		'package-id.ts':
			"await packages.invoke({ packageId: 'pkg-123', exportName: './run' })\n",
		'dynamic.ts':
			'await packages.invoke({ kodyId: targetId, exportName: exportName })\n',
		'variable.ts': 'await packages.invoke(input)\n',
		'spread.ts':
			"await packages.invoke({ kodyId: 'worker', exportName: './run', ...options })\n",
		'commented.ts':
			"await packages.invoke({ kodyId: 'worker' /* target */, exportName: './run' })\n",
		'broken.ts':
			"export default async function run( { return packages.invoke({ kodyId: 'worker', exportName: './run' })\n",
	}

	const result = invokeObjectToSpecifierCodemod.transform(files)
	expect(result.changed).toBe(true)
	expect(result.changedPaths).toEqual(['safe.ts'])
	expect(result.files['safe.ts']).toContain(
		'packages.invoke("kody:@user/worker", { exportName:',
	)
	expect(result.needsManual).toEqual([
		{
			path: 'broken.ts',
			message: expect.stringContaining('could not be parsed'),
		},
		{
			path: 'commented.ts',
			message: expect.stringContaining('cannot be migrated safely'),
		},
		{
			path: 'dynamic.ts',
			message: expect.stringContaining('cannot be migrated safely'),
		},
		{
			path: 'package-id.ts',
			message: expect.stringContaining('cannot be migrated safely'),
		},
		{
			path: 'spread.ts',
			message: expect.stringContaining('cannot be migrated safely'),
		},
		{
			path: 'variable.ts',
			message: expect.stringContaining('cannot be migrated safely'),
		},
	])
	expect(result.files['package-id.ts']).toBe(files['package-id.ts'])
	expect(result.files['dynamic.ts']).toBe(files['dynamic.ts'])
	expect(result.files['variable.ts']).toBe(files['variable.ts'])
	expect(result.files['spread.ts']).toBe(files['spread.ts'])
	expect(result.files['commented.ts']).toBe(files['commented.ts'])
	expect(result.files['broken.ts']).toBe(files['broken.ts'])
})

test('0006 migrates JavaScript and TypeScript examples in Markdown', () => {
	const files = {
		'package.json': manifest('@docs-owner/demo'),
		'README.md': [
			'# Usage',
			'',
			'```ts',
			"const result = await packages.invoke({ kodyId: 'github', exportName: './request', params: {} })",
			'```',
			'',
			"For the default export, use `packages.invoke({ exportName: '.', kodyId: 'inbox' })`.",
			'',
			'Already migrated: `packages.invoke("kody:@docs-owner/calendar/list", { params: {} })`.',
			'',
		].join('\n'),
	}

	expect(invokeObjectToSpecifierCodemod.detect(files)).toEqual([
		{
			path: 'README.md',
			message: expect.stringContaining('deprecated object-only'),
		},
	])
	const result = invokeObjectToSpecifierCodemod.transform(files)
	expect(result.changed).toBe(true)
	expect(result.changedPaths).toEqual(['README.md'])
	expect(result.needsManual).toEqual([])
	expect(result.files['README.md']).toContain(
		'packages.invoke("kody:@docs-owner/github", { exportName:',
	)
	expect(result.files['README.md']).toContain(
		'`packages.invoke("kody:@docs-owner/inbox", { exportName:',
	)
	expect(result.files['README.md']).toContain(
		'packages.invoke("kody:@docs-owner/calendar/list", { params: {} })',
	)

	const rerun = invokeObjectToSpecifierCodemod.transform(result.files)
	expect(rerun.changed).toBe(false)
	expect(rerun.files).toEqual(result.files)

	const ambiguous = {
		'package.json': manifest(),
		'README.md': [
			'# Historical API',
			'',
			'```text',
			"packages.invoke({ kodyId: 'worker', exportName: './run' })",
			'```',
			'',
		].join('\n'),
	}
	const ambiguousResult = invokeObjectToSpecifierCodemod.transform(ambiguous)
	expect(ambiguousResult.changed).toBe(false)
	expect(ambiguousResult.files).toEqual(ambiguous)
	expect(ambiguousResult.needsManual).toEqual([
		{
			path: 'README.md',
			message: expect.stringContaining('cannot be migrated safely'),
		},
	])
})

test('0006 requires a scoped manifest and is registered for admin runs', () => {
	const invalidManifestFiles = {
		'package.json': manifest('demo'),
		'index.ts':
			"await packages.invoke({ kodyId: 'worker', exportName: './run' })\n",
	}
	expect(invokeObjectToSpecifierCodemod.detect(invalidManifestFiles)).toEqual([
		{
			path: 'package.json',
			message: expect.stringContaining('scope could not be read'),
		},
	])
	const invalidResult =
		invokeObjectToSpecifierCodemod.transform(invalidManifestFiles)
	expect(invalidResult.changed).toBe(false)
	expect(invalidResult.files).toEqual(invalidManifestFiles)
	expect(invalidResult.needsManual).toEqual([
		{
			path: 'package.json',
			message: expect.stringContaining('scope could not be read'),
		},
	])

	const platformFiles = {
		'package.json': manifest('@kody/demo'),
		'index.ts':
			"await packages.invoke({ kodyId: 'worker', exportName: './run' })\n",
		'README.md': [
			'# Usage',
			'',
			'```ts',
			"await packages.invoke({ kodyId: 'github', params: {} })",
			'```',
			'',
		].join('\n'),
	}
	expect(invokeObjectToSpecifierCodemod.detect(platformFiles)).toEqual([
		{
			path: 'index.ts',
			message: expect.stringContaining('runtime caller'),
		},
		{
			path: 'README.md',
			message: expect.stringContaining('deprecated object-only'),
		},
	])
	const platformResult = invokeObjectToSpecifierCodemod.transform(platformFiles)
	expect(platformResult.changed).toBe(true)
	expect(platformResult.changedPaths).toEqual(['README.md'])
	expect(platformResult.files['index.ts']).toBe(platformFiles['index.ts'])
	expect(platformResult.files['README.md']).toContain(
		'packages.invoke("kody:@kody/github", { params: {} })',
	)
	expect(platformResult.needsManual).toEqual([
		{
			path: 'index.ts',
			message: expect.stringContaining('runtime caller'),
		},
	])

	const unrelated = {
		'package.json': manifest(),
		'index.ts': [
			'const text = "packages.invoke({ kodyId: \'worker\' })"',
			'const other = { invoke: (input) => input }',
			'other.invoke({ kodyId: "worker" })',
			'',
		].join('\n'),
	}
	expect(invokeObjectToSpecifierCodemod.detect(unrelated)).toEqual([])
	expect(invokeObjectToSpecifierCodemod.transform(unrelated).changed).toBe(
		false,
	)

	expect(getPackageCodemodById(invokeObjectToSpecifierCodemodId)).toBe(
		invokeObjectToSpecifierCodemod,
	)
})
