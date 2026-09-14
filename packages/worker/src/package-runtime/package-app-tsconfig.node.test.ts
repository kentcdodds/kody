import { expect, test } from 'vitest'
import { createPackageAppJsxBundleOptions } from './package-app-tsconfig.ts'

test('createPackageAppJsxBundleOptions is empty without a root tsconfig', () => {
	expect(
		createPackageAppJsxBundleOptions({
			'src/app.ts': 'export default { fetch() { return new Response("ok") } }',
		}),
	).toEqual({})
})

test('createPackageAppJsxBundleOptions maps tsconfig jsx settings for any import source', () => {
	expect(
		createPackageAppJsxBundleOptions({
			'tsconfig.json': JSON.stringify({
				compilerOptions: {
					jsx: 'react-jsx',
					jsxImportSource: 'remix/ui',
				},
			}),
		}),
	).toEqual({
		jsx: 'automatic',
		jsxImportSource: 'remix/ui',
	})
	expect(
		createPackageAppJsxBundleOptions({
			'tsconfig.json': JSON.stringify({
				compilerOptions: {
					jsx: 'react-jsx',
					jsxImportSource: 'preact',
				},
			}),
		}),
	).toEqual({
		jsx: 'automatic',
		jsxImportSource: 'preact',
	})
	expect(
		createPackageAppJsxBundleOptions({
			'tsconfig.json': JSON.stringify({
				compilerOptions: { jsx: 'react' },
			}),
		}),
	).toEqual({ jsx: 'transform' })
})

test('createPackageAppJsxBundleOptions ignores invalid tsconfig JSON', () => {
	expect(
		createPackageAppJsxBundleOptions({
			'tsconfig.json': '{',
		}),
	).toEqual({})
})
