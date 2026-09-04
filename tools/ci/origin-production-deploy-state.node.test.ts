import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import {
	classifyOriginProductionScriptState,
	inspectOriginProductionScriptState,
	getCloudflareWorkerScriptExists,
	isCloudflareNotFoundError,
	isCloudflareOkNonJsonError,
	originBootstrapConfigPath,
	planOriginPreviewDeploy,
	planOriginProductionDeploy,
	platformOwnedClassNames,
	previewFleetScriptNames,
	productionOriginScriptName,
	productionOriginBootstrapWorkflowName,
	productionPlatformScriptName,
	productionRuntimeScriptName,
	runtimeOwnedClassNames,
	stripOriginBindingsForLocallyOwnedClasses,
	stripOriginCrossScriptClassBindings,
	stripOriginDurableObjectMigrations,
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

test('classifies a preview fleet by its own script names, not production names', () => {
	const scriptNames = previewFleetScriptNames('kody-pr-7')
	// Production-named ownership must be invisible to a preview probe.
	const productionOwnership = [
		...transferredOn(productionPlatformScriptName, platformOwnedClassNames),
		...transferredOn(productionRuntimeScriptName, runtimeOwnedClassNames),
	]
	expect(
		classifyOriginProductionScriptState({
			originScriptExists: false,
			namespaces: productionOwnership,
			scriptNames,
		}).mode,
	).toBe('fresh')
	expect(
		classifyOriginProductionScriptState({
			originScriptExists: true,
			namespaces: [
				...productionOwnership,
				...transferredOn(scriptNames.platform, platformOwnedClassNames),
				...transferredOn(scriptNames.runtime, runtimeOwnedClassNames),
			],
			scriptNames,
		}).mode,
	).toBe('steady')
})

test('a fresh preview origin uploads the slim entry without bootstrapping', () => {
	const state = classifyOriginProductionScriptState({
		originScriptExists: false,
		namespaces: [],
		scriptNames: previewFleetScriptNames('kody-pr-7'),
	})
	expect(state.mode).toBe('fresh')
	expect(planOriginPreviewDeploy(state)).toMatchObject({
		mode: 'fresh',
		originEntry: 'slim',
	})
})

test('a retried preview run (platform/runtime deployed, origin missing) still uploads the slim entry', () => {
	const scriptNames = previewFleetScriptNames('kody-pr-7')
	const state = classifyOriginProductionScriptState({
		originScriptExists: false,
		namespaces: [
			...transferredOn(scriptNames.platform, platformOwnedClassNames),
			...transferredOn(scriptNames.runtime, runtimeOwnedClassNames),
		],
		scriptNames,
	})
	expect(state.mode).toBe('ambiguous')
	// Production would keep the full entry here; preview never owns a class
	// on origin, so ambiguity about the destinations does not change the
	// origin upload.
	expect(planOriginProductionDeploy(state).originEntry).toBe('full')
	expect(planOriginPreviewDeploy(state).originEntry).toBe('slim')
})

test('a steady preview fleet uploads the slim entry', () => {
	const scriptNames = previewFleetScriptNames('kody-pr-7')
	const state = classifyOriginProductionScriptState({
		originScriptExists: true,
		namespaces: [
			...transferredOn(scriptNames.platform, platformOwnedClassNames),
			...transferredOn(scriptNames.runtime, runtimeOwnedClassNames),
			ownership(scriptNames.origin, 'JobsHost'),
		],
		scriptNames,
	})
	expect(state.mode).toBe('steady')
	expect(planOriginPreviewDeploy(state).originEntry).toBe('slim')
})

test('a legacy preview origin that still owns transferred classes falls back to the full entry', () => {
	const scriptNames = previewFleetScriptNames('kody-pr-7')
	// Pre-slim previews bootstrapped every class on origin and also created
	// them on platform/runtime, so all three scripts own namespaces.
	const state = classifyOriginProductionScriptState({
		originScriptExists: true,
		namespaces: [
			...transferredOn(scriptNames.origin, platformOwnedClassNames),
			...transferredOn(scriptNames.origin, runtimeOwnedClassNames),
			...transferredOn(scriptNames.platform, platformOwnedClassNames),
			...transferredOn(scriptNames.runtime, runtimeOwnedClassNames),
		],
		scriptNames,
	})
	expect(state.mode).toBe('ambiguous')
	const plan = planOriginPreviewDeploy(state)
	expect(plan.originEntry).toBe('full')
	expect(plan.reason).toContain('Origin still owns')
	expect(plan.reason).toContain('MCP')
})

test('stripOriginDurableObjectMigrations removes top-level and env migrations only', () => {
	const config: Record<string, unknown> = {
		main: './src/production-worker.ts',
		migrations: [{ tag: 'v1', new_sqlite_classes: ['MCP'] }],
		durable_objects: { bindings: [] },
		env: {
			preview: {
				migrations: [{ tag: 'v1', new_sqlite_classes: ['MCP'] }],
				vars: { APP_ENV: 'preview' },
			},
			production: {
				migrations: [{ tag: 'v1', new_sqlite_classes: ['MCP'] }],
			},
		},
	}
	expect(
		stripOriginDurableObjectMigrations(structuredClone(config), 'preview'),
	).toEqual({
		main: './src/production-worker.ts',
		durable_objects: { bindings: [] },
		env: {
			preview: { vars: { APP_ENV: 'preview' } },
			production: {
				migrations: [{ tag: 'v1', new_sqlite_classes: ['MCP'] }],
			},
		},
	})
	expect(
		stripOriginDurableObjectMigrations(structuredClone(config), 'production'),
	).toEqual({
		main: './src/production-worker.ts',
		durable_objects: { bindings: [] },
		env: {
			preview: {
				migrations: [{ tag: 'v1', new_sqlite_classes: ['MCP'] }],
				vars: { APP_ENV: 'preview' },
			},
			production: {},
		},
	})
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

test('isCloudflareOkNonJsonError matches only HTTP 200 non-JSON bodies', () => {
	expect(
		isCloudflareOkNonJsonError(
			new Error(
				'Malformed Cloudflare response (200) for /workers/scripts/kody-runtime: --boundary',
			),
		),
	).toBe(true)
	expect(
		isCloudflareOkNonJsonError(
			new Error(
				'Malformed Cloudflare response (502) for /workers/scripts/kody-runtime: upstream',
			),
		),
	).toBe(false)
})

test('getCloudflareWorkerScriptExists treats a 200 multipart script download as present', async () => {
	await expect(
		getCloudflareWorkerScriptExists({
			accountId: 'acct',
			apiToken: 'token',
			scriptName: productionRuntimeScriptName,
			apiBaseUrl: 'https://cf.test',
			fetcher: async () =>
				new Response(
					'--fe71c953c6db05262becd226201515a4e42a8860e6be9669fec682876e63',
					{
						status: 200,
						headers: {
							'Content-Type':
								'multipart/form-data; boundary=fe71c953c6db05262becd226201515a4e42a8860e6be9669fec682876e63',
						},
					},
				),
		}),
	).resolves.toBe(true)
})

test('inspectOriginProductionScriptState classifies a multipart script GET plus ownership as steady', async () => {
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
						result: [
							...platformOwnedClassNames.map((className) => ({
								script: productionPlatformScriptName,
								class: className,
							})),
							...runtimeOwnedClassNames.map((className) => ({
								script: productionRuntimeScriptName,
								class: className,
							})),
						],
						result_info: { total_pages: 1 },
					}),
					{ status: 200, headers: { 'Content-Type': 'application/json' } },
				)
			}
			return new Response(
				'--fe71c953c6db05262becd226201515a4e42a8860e6be9669fec682876e63',
				{
					status: 200,
					headers: {
						'Content-Type':
							'multipart/form-data; boundary=fe71c953c6db05262becd226201515a4e42a8860e6be9669fec682876e63',
					},
				},
			)
		},
	})
	expect(state.mode).toBe('steady')
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
