import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { runBundledModuleWithRegistry } from '#mcp/run-codemode-registry.ts'
import { buildKodyModuleBundle } from './module-graph.ts'

test('saved package bundles and executes npm dependencies declared in package.json', async () => {
	const packageJson = JSON.stringify({
		name: '@kentcdodds/dependency-package',
		exports: {
			'.': './src/index.ts',
		},
		dependencies: {
			kleur: '^4.1.5',
		},
		kody: {
			id: 'dependency-package',
			description: 'Exercises npm dependency bundling',
		},
	})

	const bundle = await buildKodyModuleBundle({
		env,
		baseUrl: 'https://kody.dev',
		userId: 'user-workers-test',
		sourceFiles: {
			'package.json': packageJson,
			'src/index.ts': [
				"import kleur from 'kleur'",
				'export default async function run() {',
				"\treturn { formatted: kleur.green('dependency-ok') }",
				'}',
			].join('\n'),
		},
		entryPoint: 'src/index.ts',
	})

	const moduleSources = Object.values(bundle.modules)
		.map((module) => {
			if (typeof module === 'string') return module
			return [module.js, module.cjs, module.text]
				.filter((value): value is string => typeof value === 'string')
				.join('\n')
		})
		.join('\n')
	expect(moduleSources).toContain('dependency-ok')
	expect(moduleSources).not.toContain(`from "kleur"`)

	const result = await runBundledModuleWithRegistry(
		env,
		createMcpCallerContext({
			baseUrl: 'https://kody.dev',
			user: {
				userId: 'user-workers-test',
				email: 'worker@example.com',
				displayName: 'Worker Test',
			},
		}),
		{
			mainModule: bundle.mainModule,
			modules: bundle.modules,
		},
		undefined,
		{
			skipCapabilityRegistry: true,
		},
	)

	expect(result.error).toBeUndefined()
	expect(result.result).toEqual({
		formatted: 'dependency-ok',
	})
})
