import { expect, test } from 'vitest'
import { getPackageCodemodById } from '../registry.ts'
import {
	packagesInvokeToStaticImportCodemod,
	packagesInvokeToStaticImportCodemodId,
} from './0008-packages-invoke-to-static-import.ts'

function manifest(
	name = '@user/demo',
	dependencies?: Record<string, string> | Array<string>,
) {
	return `${JSON.stringify(
		{
			name,
			exports: { '.': './index.ts' },
			kody: {
				id: 'demo',
				description: 'Demo package for invoke-to-import codemod tests.',
				...(dependencies === undefined ? {} : { dependencies }),
			},
		},
		null,
		'\t',
	)}\n`
}

test('0008 rewrites literal invoke to a static import and records kody.dependencies', () => {
	const files = {
		'package.json': manifest('@kentcdodds/demo'),
		'index.ts': [
			"import { packages } from 'kody:runtime'",
			'',
			'export default async function run(event) {',
			"\tconst direct = await packages.invoke('kody:@kentcdodds/github/request', { params: { event } })",
			"\tconst listed = await packages.invoke('kody:@kentcdodds/inbox/list')",
			'\treturn { direct, listed }',
			'}',
			'',
		].join('\n'),
	}

	expect(packagesInvokeToStaticImportCodemod.detect(files)).toEqual([
		{
			path: 'index.ts',
			message: expect.stringContaining('static'),
		},
	])

	const result = packagesInvokeToStaticImportCodemod.transform(files)
	expect(result.changed).toBe(true)
	expect(result.changedPaths).toEqual(['index.ts', 'package.json'])
	expect(result.needsManual).toEqual([])
	expect(result.files['index.ts']).toContain(
		'import request from "kody:@kentcdodds/github/request"',
	)
	expect(result.files['index.ts']).toContain(
		'import list from "kody:@kentcdodds/inbox/list"',
	)
	expect(result.files['index.ts']).toContain('await request({ event })')
	expect(result.files['index.ts']).toContain('await list()')
	expect(result.files['index.ts']).not.toContain('packages.invoke')
	expect(result.files['index.ts']).not.toContain("from 'kody:runtime'")
	expect(JSON.parse(result.files['package.json']!).kody.dependencies).toEqual({
		'@kentcdodds/github': '*',
		'@kentcdodds/inbox': '*',
	})

	const rerun = packagesInvokeToStaticImportCodemod.transform(result.files)
	expect(rerun.changed).toBe(false)
	expect(rerun.changedPaths).toEqual([])
	expect(rerun.needsManual).toEqual([])
})

test('0008 rewrites computed specifiers to import(specifier) and leaves keyed invokes manual', () => {
	const files = {
		'package.json': manifest(),
		'dynamic.ts': [
			"import { packages } from 'kody:runtime'",
			'',
			'export default async function run(name, params) {',
			'\treturn await packages.invoke(name, { params })',
			'}',
			'',
		].join('\n'),
		'keyed.ts': [
			"import { packages } from 'kody:runtime'",
			'',
			'export default async function run(event) {',
			"\treturn await packages.invoke('kody:@user/once/run', {",
			'\t\tparams: event,',
			"\t\tidempotencyKey: 'once:1',",
			'\t})',
			'}',
			'',
		].join('\n'),
	}

	const result = packagesInvokeToStaticImportCodemod.transform(files)
	expect(result.changed).toBe(true)
	expect(result.changedPaths).toEqual(['dynamic.ts'])
	expect(result.files['dynamic.ts']).toContain(
		'return await (await import(name)).default(params)',
	)
	expect(result.files['dynamic.ts']).not.toContain('packages.invoke')
	expect(result.files['keyed.ts']).toBe(files['keyed.ts'])
	expect(result.needsManual).toEqual([
		{
			path: 'keyed.ts',
			message: expect.stringContaining('idempotencyKey'),
		},
	])
})

test('0008 rewrites Markdown fences and inline examples to static imports', () => {
	const files = {
		'package.json': manifest('@docs-owner/demo'),
		'README.md': [
			'# Usage',
			'',
			'```ts',
			"import { packages } from 'kody:runtime'",
			'',
			"const result = await packages.invoke('kody:@docs-owner/github/request', { params: {} })",
			'```',
			'',
			'Call `packages.invoke("kody:@docs-owner/inbox/list", { params: {} })` after install.',
			'',
		].join('\n'),
	}

	const result = packagesInvokeToStaticImportCodemod.transform(files)
	expect(result.changed).toBe(true)
	expect(result.changedPaths).toEqual(['README.md'])
	expect(result.needsManual).toEqual([])
	expect(result.files['README.md']).toContain(
		'import request from "kody:@docs-owner/github/request"',
	)
	expect(result.files['README.md']).toContain('await request({})')
	expect(result.files['README.md']).toContain(
		'import list from "kody:@docs-owner/inbox/list"',
	)
	expect(result.files['README.md']).not.toContain('packages.invoke')
	expect(result.files['package.json']).toBe(files['package.json'])
	expect(JSON.parse(result.files['package.json']!).kody.dependencies).toBe(
		undefined,
	)
})

test('0008 records kody.dependencies only from module rewrites, not Markdown', () => {
	const files = {
		'package.json': manifest('@user/demo'),
		'index.ts': [
			"import { packages } from 'kody:runtime'",
			'',
			'export default async function run() {',
			"\treturn await packages.invoke('kody:@user/helper/run')",
			'}',
			'',
		].join('\n'),
		'README.md': [
			'# Usage',
			'',
			'```ts',
			"await packages.invoke('kody:@docs-owner/inbox/list')",
			'```',
			'',
		].join('\n'),
	}

	const result = packagesInvokeToStaticImportCodemod.transform(files)
	expect(result.changed).toBe(true)
	expect(result.changedPaths).toEqual(['index.ts', 'package.json', 'README.md'])
	expect(JSON.parse(result.files['package.json']!).kody.dependencies).toEqual({
		'@user/helper': '*',
	})
	expect(result.files['README.md']).toContain(
		'import list from "kody:@docs-owner/inbox/list"',
	)
	expect(result.files['index.ts']).toContain('kody:@user/helper/run')
	expect(result.files['index.ts']).not.toContain('packages.invoke')
})

test('0008 reuses an existing static import and is registered for admin runs', () => {
	const files = {
		'package.json': manifest('@user/demo', { '@user/helper': '*' }),
		'index.ts': [
			"import helper from 'kody:@user/helper/run'",
			"import { packages } from 'kody:runtime'",
			'',
			"export default async function run() { return await packages.invoke('kody:@user/helper/run', { params: { ok: true } }) }",
			'',
		].join('\n'),
	}

	const result = packagesInvokeToStaticImportCodemod.transform(files)
	expect(result.changed).toBe(true)
	expect(result.changedPaths).toEqual(['index.ts'])
	expect(result.files['index.ts']).toContain('await helper({ ok: true })')
	expect(result.files['index.ts']?.match(/import helper from/g)).toHaveLength(1)
	expect(JSON.parse(result.files['package.json']!).kody.dependencies).toEqual({
		'@user/helper': '*',
	})
	expect(getPackageCodemodById(packagesInvokeToStaticImportCodemodId)).toBe(
		packagesInvokeToStaticImportCodemod,
	)
})

test('0008 rewrites static template specifiers and keeps other packages uses', () => {
	const files = {
		'package.json': manifest('@user/demo'),
		'index.ts': [
			"import { storage, packages, secrets } from 'kody:runtime'",
			'',
			'export default async function run() {',
			'\tconst listed = await packages.invoke(`kody:@user/inbox/list`)',
			'\tvoid packages.check',
			'\treturn listed',
			'}',
			'',
		].join('\n'),
	}

	const result = packagesInvokeToStaticImportCodemod.transform(files)
	expect(result.changed).toBe(true)
	expect(result.files['index.ts']).toContain(
		'import list from "kody:@user/inbox/list"',
	)
	expect(result.files['index.ts']).toContain('await list()')
	expect(result.files['index.ts']).toContain(
		"import { storage, packages, secrets } from 'kody:runtime'",
	)
	expect(result.files['index.ts']).toContain('void packages.check')
	expect(result.files['index.ts']).not.toContain('packages.invoke')
})

test('0008 leaves topic invokes manual and removes only unused packages specifiers', () => {
	const files = {
		'package.json': manifest('@user/demo'),
		'topic.ts': [
			"import { packages } from 'kody:runtime'",
			'',
			'export default async function run() {',
			"\treturn await packages.invoke('kody:@user/inbox/list', { topic: 'mail' })",
			'}',
			'',
		].join('\n'),
		'multi.ts': [
			"import { storage, packages, secrets } from 'kody:runtime'",
			'',
			'export default async function run() {',
			"\treturn await packages.invoke('kody:@user/inbox/list')",
			'}',
			'',
		].join('\n'),
	}

	const result = packagesInvokeToStaticImportCodemod.transform(files)
	expect(result.changed).toBe(true)
	expect(result.changedPaths).toEqual(['multi.ts', 'package.json'])
	expect(result.files['topic.ts']).toBe(files['topic.ts'])
	expect(result.needsManual).toEqual([
		{
			path: 'topic.ts',
			message: expect.stringContaining('import'),
		},
	])
	expect(result.files['multi.ts']).toContain(
		"import { storage, secrets } from 'kody:runtime'",
	)
	expect(result.files['multi.ts']).not.toMatch(/\{\s*,/)
	expect(result.files['multi.ts']).not.toContain('packages.invoke')
})
