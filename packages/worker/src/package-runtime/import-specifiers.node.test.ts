import { expect, test } from 'vitest'
import { collectLiteralImportSpecifiers } from './import-specifiers.ts'

test('collectLiteralImportSpecifiers ignores type-only import and export sources', () => {
	const specifiers = collectLiteralImportSpecifiers(
		[
			'import type { Config } from "kody:@kentcdodds/types/config"',
			'import helper from "kody:@kentcdodds/helper/run"',
			'export { type Result } from "kody:@kentcdodds/types/result"',
			'export { run, type RunInput } from "kody:@kentcdodds/runner"',
			'export type { Other } from "kody:@kentcdodds/types/other"',
			'export * from "kody:@kentcdodds/all"',
			'const dynamic = import("kody:@kentcdodds/dynamic")',
			'void dynamic',
			'void helper',
		].join('\n'),
	)

	expect(specifiers).toEqual([
		'kody:@kentcdodds/helper/run',
		'kody:@kentcdodds/runner',
		'kody:@kentcdodds/all',
		'kody:@kentcdodds/dynamic',
	])
})

test('collectLiteralImportSpecifiers includes declarations and TS import types when requested', () => {
	const specifiers = collectLiteralImportSpecifiers(
		[
			'import type { Config } from "kody:@kentcdodds/types/config"',
			'export type { Other } from "kody:@kentcdodds/types/other"',
			'type Detail = import("kody:@kentcdodds/types/detail").Detail',
		].join('\n'),
		{ includeTypeOnly: true },
	)

	expect(specifiers).toEqual([
		'kody:@kentcdodds/types/config',
		'kody:@kentcdodds/types/other',
		'kody:@kentcdodds/types/detail',
	])
})
