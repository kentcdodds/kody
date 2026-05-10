import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { runBundledModuleWithRegistry } from '#mcp/run-codemode-registry.ts'
import { buildKodyModuleBundle } from './module-graph.ts'

test(
	'saved package bundles and executes npm dependencies declared in package.json',
	{ timeout: 20_000 },
	async () => {
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
	},
)

test('saved package execution passes input as the default export argument', async () => {
	const packageJson = JSON.stringify({
		name: '@kentcdodds/input-package',
		exports: {
			'.': './src/index.ts',
		},
		kody: {
			id: 'input-package',
			description: 'Exercises explicit input arguments',
		},
	})
	const bundle = await buildKodyModuleBundle({
		env,
		baseUrl: 'https://kody.dev',
		userId: 'user-workers-test',
		sourceFiles: {
			'package.json': packageJson,
			'src/index.ts': [
				'export default async function main(input = {}) {',
				'\treturn { room: input.room, missing: input.missing ?? "defaulted" }',
				'}',
			].join('\n'),
		},
		entryPoint: 'src/index.ts',
	})

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
		{ room: 'office' },
		{
			skipCapabilityRegistry: true,
		},
	)

	expect(result.error).toBeUndefined()
	expect(result.result).toEqual({
		room: 'office',
		missing: 'defaulted',
	})
})

test('saved package execution exposes packages.invoke when package invoke tools are provided', async () => {
	const packageJson = JSON.stringify({
		name: '@kentcdodds/invoker-package',
		exports: {
			'.': './src/index.ts',
		},
		kody: {
			id: 'invoker-package',
			description: 'Exercises package invocation runtime helper',
		},
	})
	const bundle = await buildKodyModuleBundle({
		env,
		baseUrl: 'https://kody.dev',
		userId: 'user-workers-test',
		sourceFiles: {
			'package.json': packageJson,
			'src/index.ts': [
				"import { packageContext, packages } from 'kody:runtime'",
				'',
				'export default async function main(input = {}) {',
				'\treturn {',
				'\t\tpackageId: packageContext?.packageId ?? null,',
				"\t\thasCheck: typeof packages?.check === 'function',",
				"\t\thasInvoke: typeof packages?.invoke === 'function',",
				"\t\thasInvokeChecked: typeof packages?.invokeChecked === 'function',",
				'\t\tinvoked: await packages?.invoke({',
				"\t\t\tkodyId: 'target-package',",
				"\t\t\texportName: './run',",
				'\t\t\tparams: input,',
				'\t\t}),',
				'\t}',
				'}',
			].join('\n'),
		},
		entryPoint: 'src/index.ts',
	})
	const invokedInputs: Array<Record<string, unknown>> = []
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
		{ eventId: 'event-1' },
		{
			packageContext: {
				packageId: 'pkg-invoker',
				kodyId: 'invoker-package',
				sourceId: 'source-invoker',
			},
			packageInvokeTools: {
				check: async (input) => ({
					ok: true,
					invoke: input as {
						kodyId: string
						exportName: string
						params?: Record<string, unknown>
					},
					contract: {
						packageId: 'pkg-target',
						kodyId: 'target-package',
						name: '@kentcdodds/target-package',
						sourceId: 'source-target',
						publishedCommit: 'commit-1',
						exportName: './run',
						runtimeTarget: 'src/run.ts',
						warnings: [],
					},
				}),
				invoke: async (input) => {
					invokedInputs.push(input)
					return { ok: true, input }
				},
				invokeChecked: async (input) => {
					invokedInputs.push(input)
					return { ok: true, input }
				},
			},
			skipCapabilityRegistry: true,
		},
	)

	expect(result.error).toBeUndefined()
	expect(result.result).toEqual({
		packageId: 'pkg-invoker',
		hasCheck: true,
		hasInvoke: true,
		hasInvokeChecked: true,
		invoked: {
			ok: true,
			input: {
				kodyId: 'target-package',
				exportName: './run',
				params: { eventId: 'event-1' },
			},
		},
	})
	expect(invokedInputs).toEqual([
		{
			kodyId: 'target-package',
			exportName: './run',
			params: { eventId: 'event-1' },
		},
	])
})

test('ad hoc execute runtime exposes packages as null without package invoke tools', async () => {
	const bundle = await buildKodyModuleBundle({
		env,
		baseUrl: 'https://kody.dev',
		userId: 'user-workers-test',
		sourceFiles: {
			'entry.ts': [
				"import { packageContext, packages } from 'kody:runtime'",
				'',
				'export default async function main() {',
				'\treturn {',
				'\t\tpackageContextIsNull: packageContext === null,',
				'\t\tpackagesIsNull: packages === null,',
				"\t\thasInvoke: typeof packages?.invoke === 'function',",
				'\t}',
				'}',
			].join('\n'),
		},
		entryPoint: 'entry.ts',
	})

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
			packageContext: null,
			skipCapabilityRegistry: true,
		},
	)

	expect(result.error).toBeUndefined()
	expect(result.result).toEqual({
		packageContextIsNull: true,
		packagesIsNull: true,
		hasInvoke: false,
	})
})
