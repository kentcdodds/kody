import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import {
	classifyOriginProductionScriptState,
	inspectOriginProductionScriptState,
	isCloudflareNotFoundError,
	originBootstrapConfigPath,
	planOriginProductionDeploy,
	platformOwnedClassNames,
	productionOriginScriptName,
	productionOriginBootstrapWorkflowName,
	productionPlatformScriptName,
	productionRuntimeScriptName,
	runtimeOwnedClassNames,
	stripOriginBindingsForLocallyOwnedClasses,
	stripOriginCrossScriptClassBindings,
	writeOriginBootstrapWranglerConfig,
	type DurableObjectNamespaceOwnership,
} from './origin-production-deploy-state.ts'

function ownership(
	script: string,
	className: string,
): DurableObjectNamespaceOwnership {
	return { script, className }
}

function transferredOn(script: string, classNames: ReadonlyArray<string>) {
	return classNames.map((className) => ownership(script, className))
}

test('classifies a missing fleet with no namespaces as fresh', () => {
	const state = classifyOriginProductionScriptState({
		originScriptExists: false,
		namespaces: [],
	})
	expect(state.mode).toBe('fresh')
	const plan = planOriginProductionDeploy(state)
	expect(plan).toMatchObject({
		originEntry: 'slim',
		runOriginBootstrap: true,
		forcePlatformAndRuntime: true,
	})
})

test('classifies completed transfer ownership as steady', () => {
	const state = classifyOriginProductionScriptState({
		originScriptExists: true,
		namespaces: [
			...transferredOn(productionPlatformScriptName, platformOwnedClassNames),
			...transferredOn(productionRuntimeScriptName, runtimeOwnedClassNames),
			ownership(productionOriginScriptName, 'JobsHost'),
		],
	})
	expect(state.mode).toBe('steady')
	expect(planOriginProductionDeploy(state)).toMatchObject({
		originEntry: 'slim',
		runOriginBootstrap: false,
		forcePlatformAndRuntime: false,
	})
})

test('refuses to treat a missing origin as fresh when platform already owns a transferred class', () => {
	const state = classifyOriginProductionScriptState({
		originScriptExists: false,
		namespaces: [ownership(productionPlatformScriptName, 'MCP')],
	})
	expect(state.mode).toBe('ambiguous')
	expect(planOriginProductionDeploy(state)).toMatchObject({
		originEntry: 'full',
		runOriginBootstrap: false,
		forcePlatformAndRuntime: false,
	})
})

test('retries fresh bootstrap when origin still owns transferred classes and destinations own none', () => {
	const state = classifyOriginProductionScriptState({
		originScriptExists: true,
		namespaces: [
			...transferredOn(productionOriginScriptName, platformOwnedClassNames),
			...transferredOn(productionOriginScriptName, runtimeOwnedClassNames),
		],
	})
	expect(state.mode).toBe('fresh')
	expect(state.originOwnedTransferredClassNames).toEqual([
		...platformOwnedClassNames,
		...runtimeOwnedClassNames,
	])
	expect(planOriginProductionDeploy(state)).toMatchObject({
		originEntry: 'slim',
		runOriginBootstrap: true,
		forcePlatformAndRuntime: true,
	})
})

test('refuses to slim while origin still owns a transferred class', () => {
	const state = classifyOriginProductionScriptState({
		originScriptExists: true,
		namespaces: [
			...transferredOn(productionPlatformScriptName, platformOwnedClassNames),
			...transferredOn(productionRuntimeScriptName, runtimeOwnedClassNames),
			ownership(productionOriginScriptName, 'Mailbox'),
		],
	})
	expect(state.mode).toBe('ambiguous')
	expect(state.originOwnedTransferredClassNames).toEqual(['Mailbox'])
	expect(planOriginProductionDeploy(state).originEntry).toBe('full')
})

test('refuses to slim when platform is only partially transferred', () => {
	const state = classifyOriginProductionScriptState({
		originScriptExists: true,
		namespaces: [
			ownership(productionPlatformScriptName, 'MCP'),
			...transferredOn(productionRuntimeScriptName, runtimeOwnedClassNames),
		],
	})
	expect(state.mode).toBe('ambiguous')
})

test('an unknown origin-script probe is never fresh or steady', () => {
	const state = classifyOriginProductionScriptState({
		originScriptExists: null,
		namespaces: [],
	})
	expect(state.mode).toBe('ambiguous')
	expect(planOriginProductionDeploy(state).runOriginBootstrap).toBe(false)
})

test('falls back to script existence only when namespace listing is unavailable', () => {
	expect(
		classifyOriginProductionScriptState({
			originScriptExists: false,
			platformScriptExists: false,
			runtimeScriptExists: false,
			namespaces: null,
		}).mode,
	).toBe('fresh')
	expect(
		classifyOriginProductionScriptState({
			originScriptExists: true,
			platformScriptExists: true,
			runtimeScriptExists: true,
			namespaces: null,
		}).mode,
	).toBe('steady')
	expect(
		classifyOriginProductionScriptState({
			originScriptExists: true,
			platformScriptExists: false,
			runtimeScriptExists: true,
			namespaces: null,
		}).mode,
	).toBe('ambiguous')
})

test('isCloudflareNotFoundError matches only 404 probe failures', () => {
	expect(
		isCloudflareNotFoundError(
			new Error(
				'Cloudflare API request failed (404): workers.api.error.not_found',
			),
		),
	).toBe(true)
	expect(
		isCloudflareNotFoundError(
			new Error('Cloudflare API request failed (500): upstream'),
		),
	).toBe(false)
})

test('bootstrap config keeps the full entry and locally owns transferred classes', async () => {
	const tempDir = await mkdtemp(
		path.join(os.tmpdir(), 'kody-origin-bootstrap-'),
	)
	try {
		const generated = {
			main: './src/production-worker.ts',
			env: {
				production: {
					durable_objects: {
						bindings: [
							{
								name: 'MCP_OBJECT',
								class_name: 'MCP',
								script_name: productionPlatformScriptName,
							},
							{
								name: 'STORAGE_RUNNER',
								class_name: 'StorageRunner',
								script_name: productionRuntimeScriptName,
							},
							{
								name: 'UNRELATED',
								class_name: 'Other',
								script_name: 'someone-else',
							},
						],
					},
					workflows: [
						{
							binding: 'DYNAMIC_CALLABLE_WORKFLOWS',
							class_name: 'DynamicCallableWorkflow',
							script_name: productionRuntimeScriptName,
						},
					],
				},
			},
		}
		const outPath = path.join(tempDir, 'bootstrap.json')
		await writeOriginBootstrapWranglerConfig({
			generatedConfig: generated,
			outConfigPath: outPath,
		})
		const written = JSON.parse(await readFile(outPath, 'utf8')) as {
			main: string
			env: {
				production: {
					durable_objects: {
						bindings: Array<{ class_name: string; script_name?: string }>
					}
					workflows: Array<{
						class_name: string
						name?: string
						script_name?: string
					}>
				}
			}
		}
		expect(written.main).toBe('./src/index.ts')
		expect(
			written.env.production.durable_objects.bindings.find(
				(binding) => binding.class_name === 'MCP',
			)?.script_name,
		).toBeUndefined()
		expect(
			written.env.production.durable_objects.bindings.find(
				(binding) => binding.class_name === 'StorageRunner',
			)?.script_name,
		).toBeUndefined()
		expect(
			written.env.production.durable_objects.bindings.find(
				(binding) => binding.class_name === 'Other',
			)?.script_name,
		).toBe('someone-else')
		expect(written.env.production.workflows[0]?.script_name).toBeUndefined()
		expect(written.env.production.workflows[0]?.name).toBe(
			productionOriginBootstrapWorkflowName,
		)
		expect(generated.main).toBe('./src/production-worker.ts')
		expect(
			(
				generated.env.production.durable_objects.bindings[0] as {
					script_name?: string
				}
			).script_name,
		).toBe(productionPlatformScriptName)
	} finally {
		await rm(tempDir, { recursive: true, force: true })
	}
})

test('inspectOriginProductionScriptState fail-closes when the origin probe errors', async () => {
	const state = await inspectOriginProductionScriptState({
		accountId: 'acct',
		apiToken: 'token',
		apiBaseUrl: 'https://cf.test',
		fetcher: async () => {
			throw new Error('fetch failed')
		},
	})
	expect(state.mode).toBe('ambiguous')
	expect(state.reason).toContain('Cloudflare script probe failed')
})

test('inspectOriginProductionScriptState classifies a missing fleet from 404 probes', async () => {
	const state = await inspectOriginProductionScriptState({
		accountId: 'acct',
		apiToken: 'token',
		apiBaseUrl: 'https://cf.test',
		fetcher: async (input) => {
			const url = String(input)
			if (url.includes('/workers/durable_objects/namespaces')) {
				return new Response(
					JSON.stringify({
						success: true,
						result: [],
						result_info: { total_pages: 1 },
					}),
					{ status: 200, headers: { 'Content-Type': 'application/json' } },
				)
			}
			return new Response(
				JSON.stringify({
					success: false,
					errors: [{ code: 10007, message: 'not found' }],
				}),
				{ status: 404, headers: { 'Content-Type': 'application/json' } },
			)
		},
	})
	expect(state.mode).toBe('fresh')
})

test('stripOriginBindingsForLocallyOwnedClasses keeps transferred destination bindings', () => {
	const config = {
		env: {
			production: {
				durable_objects: {
					bindings: [
						{
							name: 'MCP_OBJECT',
							class_name: 'MCP',
							script_name: productionPlatformScriptName,
						},
						{
							name: 'STORAGE_RUNNER',
							class_name: 'StorageRunner',
							script_name: productionRuntimeScriptName,
						},
					],
				},
				workflows: [
					{
						binding: 'DYNAMIC_CALLABLE_WORKFLOWS',
						name: 'kody-runtime-dynamic-callable-workflows',
						class_name: 'DynamicCallableWorkflow',
						script_name: productionRuntimeScriptName,
					},
				],
			},
		},
	}
	stripOriginBindingsForLocallyOwnedClasses(config, ['StorageRunner'])
	expect(
		(
			config.env.production.durable_objects.bindings[0] as {
				script_name?: string
			}
		).script_name,
	).toBe(productionPlatformScriptName)
	expect(
		(
			config.env.production.durable_objects.bindings[1] as {
				script_name?: string
			}
		).script_name,
	).toBeUndefined()
	expect(
		(
			config.env.production.workflows[0] as {
				name?: string
				script_name?: string
			}
		).script_name,
	).toBeUndefined()
	expect((config.env.production.workflows[0] as { name?: string }).name).toBe(
		productionOriginBootstrapWorkflowName,
	)
})

test('stripOriginCrossScriptClassBindings is a no-op when there are no matching script names', () => {
	const config = {
		env: {
			production: {
				durable_objects: {
					bindings: [
						{
							name: 'MCP_OBJECT',
							class_name: 'MCP',
							script_name: productionPlatformScriptName,
						},
					],
				},
			},
		},
	}
	stripOriginCrossScriptClassBindings(config, new Set(['other-script']))
	expect(
		(
			config.env.production.durable_objects.bindings[0] as {
				script_name?: string
			}
		).script_name,
	).toBe(productionPlatformScriptName)
})

test('originBootstrapConfigPath writes beside the generated config and rejects other suffixes', () => {
	expect(
		originBootstrapConfigPath(
			'packages/worker/wrangler-production.generated.json',
		),
	).toBe('packages/worker/wrangler-production-bootstrap.generated.json')
	expect(() =>
		originBootstrapConfigPath('packages/worker/wrangler-production.json'),
	).toThrow(/\.generated\.json/)
})
