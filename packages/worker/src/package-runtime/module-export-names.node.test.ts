import { expect, test } from 'vitest'
import { collectModuleExportNames } from './module-export-names.ts'

test('collects value exports across declarations, re-exports, and artifact JS', () => {
	expect(
		collectModuleExportNames({
			files: {
				'pkg/index.ts': [
					'export function add(left: number, right: number) { return left + right }',
					'export async function fetchStuff() {}',
					'export class Toolbox {}',
					'export const answer = 42',
					'export const { first, rest: [second] } = { first: 1, rest: [2] }',
					'export const [third, ...others] = [3, 4]',
					'const hidden = () => {}',
					'export { hidden as renamed }',
					'export default function main() {}',
					'export type Loud = string',
					'export interface Config { value: number }',
					'export declare function ghost(): void',
					'export type { AnotherType } from "./types.ts"',
					'type Local = number',
					'export { type Local, realValue } from "./values.ts"',
					'export function real() {}',
				].join('\n'),
				'pkg/values.ts': 'export const realValue = 1',
			},
			modulePath: 'pkg/index.ts',
		}),
	).toEqual([
		'Toolbox',
		'add',
		'answer',
		'fetchStuff',
		'first',
		'others',
		'real',
		'realValue',
		'renamed',
		'second',
		'third',
	])

	// Shape of esbuild output for a published importable-module artifact.
	expect(
		collectModuleExportNames({
			files: {
				'artifact/index.js': [
					'var entry_default = async function main() {}',
					'function listItems() {}',
					'export { entry_default as default, listItems }',
				].join('\n'),
			},
			modulePath: 'artifact/index.js',
		}),
	).toEqual(['listItems'])
})

test('follows export-star chains and tolerates cycles and parse failures', () => {
	expect(
		collectModuleExportNames({
			files: {
				'pkg/index.ts': [
					"export * from './math.ts'",
					"export * from './extensionless'",
					"export * as helpers from './helpers.ts'",
					"export * from 'some-npm-package'",
					'export const local = 1',
				].join('\n'),
				'pkg/math.ts':
					"export function multiply() {}\nexport * from './deep/nested.ts'",
				'pkg/deep/nested.ts': 'export const nestedValue = 2',
				'pkg/extensionless.ts': 'export const extensionless = 3',
				'pkg/helpers.ts': 'export const shouldStayHidden = 4',
			},
			modulePath: 'pkg/index.ts',
		}),
	).toEqual(['extensionless', 'helpers', 'local', 'multiply', 'nestedValue'])

	expect(
		collectModuleExportNames({
			files: {
				'pkg/a.ts': [
					"export * from './b.ts'",
					'const value = 1',
					'export { value as "not an identifier" }',
					'export { value as default }',
				].join('\n'),
				'pkg/b.ts': "export * from './a.ts'\nexport const fromB = 2",
			},
			modulePath: 'pkg/a.ts',
		}),
	).toEqual(['fromB'])

	expect(
		collectModuleExportNames({
			files: { 'pkg/broken.ts': 'export const = not parseable {{{' },
			modulePath: 'pkg/broken.ts',
		}),
	).toEqual([])
	expect(
		collectModuleExportNames({
			files: {},
			modulePath: 'pkg/missing.ts',
		}),
	).toEqual([])
})
