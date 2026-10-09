import { expect, test } from 'vitest'
import { getPackageCodemodById } from '../registry.ts'
import {
	invokeObjectToSpecifierCodemod as codemod,
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

function findings(entries: Array<[path: string, snippet: string]>) {
	return entries.map(([path, snippet]) => ({
		path,
		message: expect.stringContaining(snippet),
	}))
}

function expectUnchangedWithManual(
	files: Record<string, string>,
	manual: Array<[path: string, snippet: string]>,
) {
	expect(codemod.detect(files)).toEqual(findings(manual))
	const result = codemod.transform(files)
	expect(result.changed).toBe(false)
	expect(result.files).toEqual(files)
	expect(result.needsManual).toEqual(findings(manual))
}

function expectIdempotent(files: Record<string, string>) {
	const rerun = codemod.transform(files)
	expect(rerun.changed).toBe(false)
	expect(rerun.changedPaths).toEqual([])
	expect(rerun.needsManual).toEqual([])
	expect(rerun.files).toEqual(files)
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
			'\treturn { direct, optional }',
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

	expect(codemod.detect(files)).toEqual(
		findings([['index.ts', 'removed object-only']]),
	)
	const result = codemod.transform(files)
	expect(result).toMatchObject({
		changed: true,
		changedPaths: ['index.ts'],
		needsManual: [],
	})
	expect(result.files['index.ts']).toContain(
		'packages.invoke("kody:@kentcdodds/github", { exportName:',
	)
	expect(result.files['index.ts']).toContain(
		'packages?.invoke("kody:@kentcdodds/inbox", { exportName:',
	)
	expect(result.files['index.ts']).not.toContain("kodyId: '")
	expect(result.files['already-migrated.ts']).toBe(files['already-migrated.ts'])
	expectIdempotent(result.files)
})

test('0006 partially migrates safe files and reports ambiguous calls for review', () => {
	const unsafe = {
		'package-id.ts':
			"await packages.invoke({ packageId: 'pkg-123', exportName: './run' })\n",
		'dynamic.ts':
			'await packages.invoke({ kodyId: targetId, exportName: exportName })\n',
		'missing-export.ts': "await packages.invoke({ kodyId: 'worker' })\n",
		'missing-export-options.ts':
			"await packages.invoke({ kodyId: 'worker', params: {} })\n",
		'variable.ts': 'await packages.invoke(input)\n',
		'spread.ts':
			"await packages.invoke({ kodyId: 'worker', exportName: './run', ...options })\n",
		'commented.ts':
			"await packages.invoke({ kodyId: 'worker' /* target */, exportName: './run' })\n",
	}
	const broken =
		"export default async function run( { return packages.invoke({ kodyId: 'worker', exportName: './run' })\n"
	const files = {
		'package.json': manifest(),
		'safe.ts':
			"await packages.invoke({ exportName: './run', kodyId: 'worker', topic: 'jobs' })\n",
		'broken.ts': broken,
		...unsafe,
	}

	const result = codemod.transform(files)
	expect(result.changed).toBe(true)
	expect(result.changedPaths).toEqual(['safe.ts'])
	expect(result.files['safe.ts']).toContain(
		'packages.invoke("kody:@user/worker", { exportName:',
	)
	expect(result.needsManual).toEqual(
		findings([
			['broken.ts', 'could not be parsed'],
			...Object.keys(unsafe)
				.sort()
				.map((path): [string, string] => [path, 'cannot be migrated safely']),
		]),
	)
	expect(result.files).toMatchObject({ ...unsafe, 'broken.ts': broken })
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

	expect(codemod.detect(files)).toEqual(
		findings([['README.md', 'removed object-only']]),
	)
	const result = codemod.transform(files)
	expect(result).toMatchObject({
		changed: true,
		changedPaths: ['README.md'],
		needsManual: [],
	})
	for (const snippet of [
		'packages.invoke("kody:@docs-owner/github", { exportName:',
		'`packages.invoke("kody:@docs-owner/inbox", { exportName:',
		'packages.invoke("kody:@docs-owner/calendar/list", { params: {} })',
	]) {
		expect(result.files['README.md']).toContain(snippet)
	}
	expectIdempotent(result.files)

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
	const ambiguousResult = codemod.transform(ambiguous)
	expect(ambiguousResult.changed).toBe(false)
	expect(ambiguousResult.files).toEqual(ambiguous)
	expect(ambiguousResult.needsManual).toEqual(
		findings([['README.md', 'cannot be migrated safely']]),
	)
})

test('0006 requires a scoped manifest and is registered for admin runs', () => {
	const workerInvoke =
		"await packages.invoke({ kodyId: 'worker', exportName: './run' })\n"
	const docsInvoke = (kodyId: string, exportName: string) =>
		[
			'# Usage',
			'',
			'```ts',
			`await packages.invoke({ kodyId: '${kodyId}', exportName: '${exportName}', params: {} })`,
			'```',
			'',
		].join('\n')

	expectUnchangedWithManual(
		{ 'package.json': manifest('demo'), 'index.ts': workerInvoke },
		[['package.json', 'scope could not be read']],
	)

	const platformFiles = {
		'package.json': manifest('@kody/demo'),
		'index.ts': workerInvoke,
		'README.md': docsInvoke('github', './request'),
	}
	expect(codemod.detect(platformFiles)).toEqual(
		findings([
			['index.ts', 'runtime caller'],
			['README.md', 'removed object-only'],
		]),
	)
	const platformResult = codemod.transform(platformFiles)
	expect(platformResult).toMatchObject({
		changed: true,
		changedPaths: ['README.md'],
		needsManual: findings([['index.ts', 'runtime caller']]),
	})
	expect(platformResult.files['index.ts']).toBe(workerInvoke)
	expect(platformResult.files['README.md']).toContain(
		'packages.invoke("kody:@kody/github", { exportName:',
	)

	for (const packageName of [
		'@kody/notify',
		'@kody/personal-capture',
		'@kody/stash',
	]) {
		expectUnchangedWithManual(
			{
				'package.json': manifest(packageName),
				'README.md': docsInvoke('helper', './run'),
			},
			[['README.md', 'user-fork owner']],
		)
	}

	const unrelated = {
		'package.json': manifest(),
		'index.ts': [
			'const text = "packages.invoke({ kodyId: \'worker\' })"',
			'const other = { invoke: (input) => input }',
			'other.invoke({ kodyId: "worker" })',
			'',
		].join('\n'),
	}
	expect(codemod.detect(unrelated)).toEqual([])
	expect(codemod.transform(unrelated).changed).toBe(false)

	expect(getPackageCodemodById(invokeObjectToSpecifierCodemodId)).toBe(codemod)
})
