import { expect, test } from 'vitest'
import { createPackageAppJsxBundleOptions } from './package-app-tsconfig.ts'

test('createPackageAppJsxBundleOptions maps tsconfig jsx and ignores missing or invalid files', () => {
	expect(
		createPackageAppJsxBundleOptions({
			'src/app.ts': 'export default { fetch() { return new Response("ok") } }',
		}),
	).toEqual({})
	expect(
		createPackageAppJsxBundleOptions({
			'tsconfig.json': '{',
		}),
	).toEqual({})
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
	expect(
		createPackageAppJsxBundleOptions({
			'tsconfig.json': `{
  // Remix recipe
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "remix/ui", /* trailing comma next */
  },
}`,
		}),
	).toEqual({
		jsx: 'automatic',
		jsxImportSource: 'remix/ui',
	})
})
