import { expect, test } from 'vitest'
import { runtimeModulePath } from './module-graph-paths.ts'
import { createKodyRuntimeExternalsPlugin } from './module-graph-bundle-builders.ts'

test('kody runtime externals plugin marks shared runtime paths external', () => {
	const plugin = createKodyRuntimeExternalsPlugin()
	expect(plugin.name).toBe('kody-runtime-externals')
	let resolve:
		| ((args: {
				path: string
				resolveDir: string
				kind: string
		  }) => { path: string; external: true } | undefined)
		| null = null
	plugin.setup({
		onResolve(_options, callback) {
			resolve = callback
		},
	})
	expect(resolve).not.toBeNull()
	expect(
		resolve?.({
			path: '../runtime.js',
			resolveDir: '.__kody_virtual__/package-runtime',
			kind: 'import-statement',
		}),
	).toEqual({ path: `./${runtimeModulePath}`, external: true })
	expect(
		resolve?.({
			path: runtimeModulePath,
			resolveDir: '',
			kind: 'import-statement',
		}),
	).toEqual({ path: `./${runtimeModulePath}`, external: true })
	// Package-runtime facades stay inlined (only the shared ALS owner is external).
	expect(
		resolve?.({
			path: './706b672d.js',
			resolveDir: '.__kody_virtual__/package-runtime',
			kind: 'import-statement',
		}),
	).toBeUndefined()
	expect(
		resolve?.({
			path: './wake.ts',
			resolveDir: '.__kody_root__',
			kind: 'import-statement',
		}),
	).toBeUndefined()
	expect(
		resolve?.({
			path: runtimeModulePath,
			resolveDir: '',
			kind: 'entry-point',
		}),
	).toBeUndefined()
})
