import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	createWorker: vi.fn(),
}))

vi.mock('#worker/worker-bundler-modules.ts', () => ({
	importWorkerBundler: async () => ({
		createWorker: (...args: Array<unknown>) => mockModule.createWorker(...args),
	}),
}))

import { packageAppClientModuleNamePattern } from './package-app-client-module-name.ts'
import { isVendoredRemixPath } from './package-app-remix.ts'

const { buildKodyAppClientBundle, isDeclaredClientExternal } =
	await import('./module-graph-client-bundle.ts')

const packageJson = JSON.stringify({
	name: '@kentcdodds/client-app',
	exports: { '.': './src/index.ts' },
	kody: {
		id: 'client-app',
		description: 'Client app',
		app: { entry: './src/app.ts', client: './src/client.ts' },
	},
})

function mockBundledOutput(source: string) {
	mockModule.createWorker.mockReset()
	mockModule.createWorker.mockResolvedValue({
		mainModule: 'bundle.js',
		modules: { 'bundle.js': source },
	})
}

test('buildKodyAppClientBundle bundles only the browser graph and names the output by content hash', async () => {
	mockBundledOutput('console.log("hello from the browser");\n')
	const sourceFiles = {
		'package.json': packageJson,
		'wrangler.toml': 'compatibility_flags = ["nodejs_compat"]',
		'src/index.ts': "import { kody } from 'kody:runtime'\nexport default kody",
		'src/app.ts': "import { kody } from 'kody:runtime'\nexport default {}",
		'src/client.ts': "import { greet } from './greet.ts'\ngreet()",
		'src/greet.ts': 'export function greet() { console.log("hi") }',
		'src/unrelated.ts': "import 'node:fs'",
		'node_modules/left-pad/package.json': '{"name":"left-pad"}',
		'node_modules/left-pad/index.js': 'module.exports = () => {}',
	}

	const bundle = await buildKodyAppClientBundle({
		sourceFiles,
		entryPoint: './src/client.ts',
	})

	expect(bundle.mainModule).toMatch(packageAppClientModuleNamePattern)
	expect(bundle.modules).toEqual({
		[bundle.mainModule]: 'console.log("hello from the browser");\n',
	})
	expect(bundle.dependencies).toEqual([])

	const call = mockModule.createWorker.mock.calls[0]?.[0] as {
		files: Record<string, string>
		entryPoint: string
		bundle: boolean
	}
	expect(call.entryPoint).toBe('src/client.ts')
	expect(call.bundle).toBe(true)
	const fileKeys = Object.keys(call.files).sort()
	expect(fileKeys.filter((key) => !isVendoredRemixPath(key))).toEqual([
		'node_modules/left-pad/index.js',
		'node_modules/left-pad/package.json',
		'package.json',
		'src/client.ts',
		'src/greet.ts',
	])
	// The platform's vendored Remix rides along so `remix/ui` resolves in
	// the browser graph without an npm install.
	expect(fileKeys).toContain('node_modules/remix/package.json')
	expect(fileKeys).toContain('node_modules/remix/dist/ui.js')
	// A plain DOM client keeps esbuild's JSX defaults.
	expect(call).not.toHaveProperty('jsxImportSource')

	const same = await buildKodyAppClientBundle({
		sourceFiles,
		entryPoint: 'src/client.ts',
	})
	expect(same.mainModule).toBe(bundle.mainModule)

	mockBundledOutput('console.log("changed");\n')
	const changed = await buildKodyAppClientBundle({
		sourceFiles,
		entryPoint: 'src/client.ts',
	})
	expect(changed.mainModule).not.toBe(bundle.mainModule)
})

test('buildKodyAppClientBundle rejects kody:, cloudflare:, and node: imports before bundling', async () => {
	mockBundledOutput('')
	await expect(
		buildKodyAppClientBundle({
			sourceFiles: {
				'package.json': packageJson,
				'src/client.ts': [
					"import { packageContext } from 'kody:runtime'",
					"import helper from 'kody:@kentcdodds/helper'",
					"import { shared } from './shared.ts'",
					'console.log(packageContext, helper, shared)',
				].join('\n'),
				'src/shared.ts': [
					"import { DurableObject } from 'cloudflare:workers'",
					"import { readFile } from 'node:fs/promises'",
					'export const shared = [DurableObject, readFile]',
				].join('\n'),
			},
			entryPoint: 'src/client.ts',
		}),
	).rejects.toThrow(
		/imports server-only modules that cannot run in the browser \(src\/client\.ts: "kody:@kentcdodds\/helper", "kody:runtime"; src\/shared\.ts: "cloudflare:workers", "node:fs\/promises"\)/,
	)
	expect(mockModule.createWorker).not.toHaveBeenCalled()
})

test('buildKodyAppClientBundle rejects stylesheet imports with an assets-directory hint', async () => {
	mockBundledOutput('')
	await expect(
		buildKodyAppClientBundle({
			sourceFiles: {
				'package.json': packageJson,
				'src/client.ts': "import './styles.css'\nconsole.log('styled')",
				'src/styles.css': 'body { margin: 0 }',
			},
			entryPoint: 'src/client.ts',
		}),
	).rejects.toThrow(
		/imports stylesheets \(src\/client\.ts: "\.\/styles\.css"\)/,
	)
	expect(mockModule.createWorker).not.toHaveBeenCalled()
})

test('buildKodyAppClientBundle fails when the bundled output still imports unresolved or server-only specifiers', async () => {
	const sourceFiles = {
		'package.json': packageJson,
		'src/client.ts': "import preact from 'preact'\npreact()",
	}
	mockBundledOutput('import preact from "preact";\npreact();\n')
	await expect(
		buildKodyAppClientBundle({ sourceFiles, entryPoint: 'src/client.ts' }),
	).rejects.toThrow(
		/still contains unresolved bare package imports after bundling \("preact"\)/,
	)

	mockBundledOutput('import { env } from "cloudflare:workers";\nenv();\n')
	await expect(
		buildKodyAppClientBundle({ sourceFiles, entryPoint: 'src/client.ts' }),
	).rejects.toThrow(
		/still references server-only modules after bundling \("cloudflare:workers"\)/,
	)

	mockBundledOutput(
		'import { h } from "https://esm.sh/preact";\nexport { h };\n',
	)
	const urlImports = await buildKodyAppClientBundle({
		sourceFiles,
		entryPoint: 'src/client.ts',
	})
	expect(urlImports.mainModule).toMatch(packageAppClientModuleNamePattern)
})

test('buildKodyAppClientBundle keeps declared externals as bare imports for an import map and passes them to the bundler', async () => {
	const packageJsonWithExternals = JSON.stringify({
		name: '@kentcdodds/client-app',
		exports: { '.': './src/index.ts' },
		kody: {
			id: 'client-app',
			description: 'Client app',
			app: {
				entry: './src/app.ts',
				client: {
					entry: './src/client.ts',
					externals: ['@remix-run/ui', 'preact'],
				},
			},
		},
	})
	const sourceFiles = {
		'package.json': packageJsonWithExternals,
		'src/client.ts': [
			"import { Button } from '@remix-run/ui'",
			"import { render } from 'preact'",
			"import { useState } from 'preact/hooks'",
			'render(Button, useState)',
		].join('\n'),
	}
	mockBundledOutput(
		[
			'import { Button } from "@remix-run/ui";',
			'import { render } from "preact";',
			'import { useState } from "preact/hooks";',
			'render(Button, useState);',
			'',
		].join('\n'),
	)

	const bundle = await buildKodyAppClientBundle({
		sourceFiles,
		entryPoint: 'src/client.ts',
	})
	expect(bundle.mainModule).toMatch(packageAppClientModuleNamePattern)
	expect(bundle.modules[bundle.mainModule]).toContain('from "@remix-run/ui"')
	// Externals reach esbuild through a plugin with exact-or-subpath matching
	// (the bundler's own `externals` option is a raw prefix match).
	const call = mockModule.createWorker.mock.calls[0]?.[0] as {
		externals?: Array<string>
		__dangerouslyUseEsBuildPluginsDoNotUseOrYouWillBeFired?: Array<{
			name: string
			setup(build: {
				onResolve(
					options: { filter: RegExp },
					callback: (args: { path: string }) => unknown,
				): void
			}): void
		}>
	}
	expect(call.externals).toBeUndefined()
	const [plugin] =
		call.__dangerouslyUseEsBuildPluginsDoNotUseOrYouWillBeFired ?? []
	expect(plugin?.name).toBe('kody-package-app-client-externals')
	let resolve: ((args: { path: string }) => unknown) | null = null
	let filter: RegExp | null = null
	plugin?.setup({
		onResolve(options, callback) {
			filter = options.filter
			resolve = callback
		},
	})
	expect(filter?.test('preact')).toBe(true)
	expect(filter?.test('@remix-run/ui')).toBe(true)
	expect(filter?.test('./local.ts')).toBe(false)
	expect(filter?.test('/abs.js')).toBe(false)
	expect(resolve?.({ path: '@remix-run/ui' })).toEqual({
		path: '@remix-run/ui',
		external: true,
	})
	expect(resolve?.({ path: 'preact/hooks' })).toEqual({
		path: 'preact/hooks',
		external: true,
	})
	expect(resolve?.({ path: 'preact-render-to-string' })).toBeUndefined()
	expect(resolve?.({ path: '@remix-run/ui-extra' })).toBeUndefined()

	expect(isDeclaredClientExternal('preact/hooks', ['preact'])).toBe(true)
	expect(isDeclaredClientExternal('preact-render-to-string', ['preact'])).toBe(
		false,
	)

	// An undeclared bare import is still a publish error, with the externals
	// path named as one of the fixes.
	mockBundledOutput('import { signal } from "@preact/signals";\nsignal();\n')
	await expect(
		buildKodyAppClientBundle({ sourceFiles, entryPoint: 'src/client.ts' }),
	).rejects.toThrow(
		/unresolved bare package imports after bundling \("@preact\/signals"\)[\s\S]*kody\.app\.client\.externals/,
	)
})

test('buildKodyAppClientBundle names a missing client entry', async () => {
	mockBundledOutput('')
	await expect(
		buildKodyAppClientBundle({
			sourceFiles: { 'package.json': packageJson },
			entryPoint: './src/client.ts',
		}),
	).rejects.toThrow(
		/Saved package app client "src\/client\.ts" bundle entry was not found/,
	)
})
