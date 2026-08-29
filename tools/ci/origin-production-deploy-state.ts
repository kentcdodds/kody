import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { cloudflareApiRequest } from './resource-utils.ts'
import { defaultDevEntryPath } from '../check-origin-production-exports.ts'

export const productionOriginScriptName = 'kody-production'
export const productionPlatformScriptName = 'kody-platform'
export const productionRuntimeScriptName = 'kody-runtime'

export const platformOwnedClassNames = [
	'MCP',
	'McpClientHub',
	'OAuthPurgeCoordinator',
	'UserMeter',
	'Mailbox',
	'RepoSession',
	'RepoSessionIndex',
	'StripePlanRefresh',
] as const

export const runtimeOwnedClassNames = [
	'StorageRunner',
	'RunLog',
	'PackageRealtimeSession',
] as const

const transferredClassNames = [
	...platformOwnedClassNames,
	...runtimeOwnedClassNames,
] as const

export type OriginProductionDeployMode = 'fresh' | 'steady' | 'ambiguous'

export type DurableObjectNamespaceOwnership = {
	script: string
	className: string
}

export type OriginProductionScriptState = {
	mode: OriginProductionDeployMode
	reason: string
}

export type OriginProductionDeployPlan = {
	mode: OriginProductionDeployMode
	originEntry: 'full' | 'slim'
	runOriginBootstrap: boolean
	forcePlatformAndRuntime: boolean
	reason: string
}

export function isCloudflareNotFoundError(error: unknown) {
	if (!(error instanceof Error)) return false
	return /Cloudflare API request failed \(404\)/.test(error.message)
}

export function planOriginProductionDeploy(
	state: OriginProductionScriptState,
): OriginProductionDeployPlan {
	if (state.mode === 'fresh') {
		return {
			mode: 'fresh',
			originEntry: 'slim',
			runOriginBootstrap: true,
			forcePlatformAndRuntime: true,
			reason: state.reason,
		}
	}
	if (state.mode === 'steady') {
		return {
			mode: 'steady',
			originEntry: 'slim',
			runOriginBootstrap: false,
			forcePlatformAndRuntime: false,
			reason: state.reason,
		}
	}
	return {
		mode: 'ambiguous',
		originEntry: 'full',
		runOriginBootstrap: false,
		forcePlatformAndRuntime: false,
		reason: state.reason,
	}
}

function classesOnScript(
	namespaces: ReadonlyArray<DurableObjectNamespaceOwnership>,
	script: string,
) {
	return new Set(
		namespaces
			.filter((entry) => entry.script === script)
			.map((entry) => entry.className),
	)
}

function everyClassOnScript(
	namespaces: ReadonlyArray<DurableObjectNamespaceOwnership>,
	script: string,
	classNames: ReadonlyArray<string>,
) {
	const owned = classesOnScript(namespaces, script)
	return classNames.every((className) => owned.has(className))
}

function anyTransferredClassOnScript(
	namespaces: ReadonlyArray<DurableObjectNamespaceOwnership>,
	script: string,
) {
	const owned = classesOnScript(namespaces, script)
	return transferredClassNames.some((className) => owned.has(className))
}

/**
 * Fail-closed classification of the live production origin script.
 *
 * `null` means the probe failed or was skipped (dry-run). That is never
 * treated as fresh or steady — both of those require positive evidence.
 */
export function classifyOriginProductionScriptState(input: {
	originScriptExists: boolean | null
	platformScriptExists?: boolean | null
	runtimeScriptExists?: boolean | null
	namespaces: ReadonlyArray<DurableObjectNamespaceOwnership> | null
}): OriginProductionScriptState {
	if (input.originScriptExists === null) {
		return {
			mode: 'ambiguous',
			reason:
				'Origin script existence is unknown; keep the full entry and do not bootstrap transfers.',
		}
	}

	if (input.namespaces) {
		const destinationsOwnTransferred =
			everyClassOnScript(
				input.namespaces,
				productionPlatformScriptName,
				platformOwnedClassNames,
			) &&
			everyClassOnScript(
				input.namespaces,
				productionRuntimeScriptName,
				runtimeOwnedClassNames,
			)
		const originOwnsTransferred = anyTransferredClassOnScript(
			input.namespaces,
			productionOriginScriptName,
		)

		if (
			!input.originScriptExists &&
			!destinationsOwnTransferred &&
			!originOwnsTransferred &&
			!anyTransferredClassOnScript(
				input.namespaces,
				productionPlatformScriptName,
			) &&
			!anyTransferredClassOnScript(
				input.namespaces,
				productionRuntimeScriptName,
			)
		) {
			return {
				mode: 'fresh',
				reason:
					'Origin script is missing and no transferred Durable Object namespace exists on origin, platform, or runtime.',
			}
		}

		if (
			input.originScriptExists &&
			destinationsOwnTransferred &&
			!originOwnsTransferred
		) {
			return {
				mode: 'steady',
				reason:
					'Origin script exists, platform and runtime own every transferred class, and origin owns none of them.',
			}
		}

		return {
			mode: 'ambiguous',
			reason:
				'Durable Object namespace ownership does not match a fresh script or a completed platform/runtime transfer.',
		}
	}

	if (
		input.originScriptExists === false &&
		input.platformScriptExists === false &&
		input.runtimeScriptExists === false
	) {
		return {
			mode: 'fresh',
			reason:
				'Origin, platform, and runtime scripts are all missing (namespace listing unavailable).',
		}
	}

	if (
		input.originScriptExists === true &&
		input.platformScriptExists === true &&
		input.runtimeScriptExists === true
	) {
		return {
			mode: 'steady',
			reason:
				'Origin, platform, and runtime scripts all exist (namespace listing unavailable; Cloudflare rejects a slim upload if origin still owns a class).',
		}
	}

	return {
		mode: 'ambiguous',
		reason:
			'Could not list Durable Object namespaces, and the three production scripts are not uniformly present or missing.',
	}
}

export async function getCloudflareWorkerScriptExists(input: {
	accountId: string
	apiToken: string
	scriptName: string
	apiBaseUrl?: string
	fetcher?: typeof fetch
}): Promise<boolean> {
	try {
		await cloudflareApiRequest<Record<string, unknown>>({
			accountId: input.accountId,
			apiToken: input.apiToken,
			pathname: `/workers/scripts/${encodeURIComponent(input.scriptName)}`,
			...(input.apiBaseUrl ? { apiBaseUrl: input.apiBaseUrl } : {}),
			...(input.fetcher ? { fetcher: input.fetcher } : {}),
		})
		return true
	} catch (error) {
		if (isCloudflareNotFoundError(error)) return false
		throw error
	}
}

function readNamespaceOwnership(
	entry: unknown,
): DurableObjectNamespaceOwnership | null {
	if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
	const record = entry as Record<string, unknown>
	const script = record.script
	const className =
		typeof record.class === 'string'
			? record.class
			: typeof record.class_name === 'string'
				? record.class_name
				: null
	if (typeof script !== 'string' || script.length === 0) return null
	if (!className || className.length === 0) return null
	return { script, className }
}

export async function listCloudflareDurableObjectNamespaces(input: {
	accountId: string
	apiToken: string
	apiBaseUrl?: string
	fetcher?: typeof fetch
}): Promise<Array<DurableObjectNamespaceOwnership>> {
	const namespaces: Array<DurableObjectNamespaceOwnership> = []
	let page = 1
	for (;;) {
		const payload = await cloudflareApiRequest<unknown>({
			accountId: input.accountId,
			apiToken: input.apiToken,
			pathname: `/workers/durable_objects/namespaces?page=${String(page)}&per_page=100`,
			...(input.apiBaseUrl ? { apiBaseUrl: input.apiBaseUrl } : {}),
			...(input.fetcher ? { fetcher: input.fetcher } : {}),
		})
		const result = payload.result
		const batch = Array.isArray(result)
			? result
			: result &&
				  typeof result === 'object' &&
				  Array.isArray((result as { namespaces?: unknown }).namespaces)
				? (result as { namespaces: Array<unknown> }).namespaces
				: null
		if (!batch) {
			throw new Error(
				'Cloudflare Durable Object namespace listing returned a malformed result.',
			)
		}
		for (const entry of batch) {
			const ownership = readNamespaceOwnership(entry)
			if (ownership) namespaces.push(ownership)
		}
		const totalPages = payload.result_info?.total_pages
		if (typeof totalPages !== 'number' || page >= totalPages) break
		page += 1
	}
	return namespaces
}

export async function inspectOriginProductionScriptState(input: {
	accountId: string
	apiToken: string
	apiBaseUrl?: string
	fetcher?: typeof fetch
}): Promise<OriginProductionScriptState> {
	try {
		const [originScriptExists, platformScriptExists, runtimeScriptExists] =
			await Promise.all([
				getCloudflareWorkerScriptExists({
					...input,
					scriptName: productionOriginScriptName,
				}),
				getCloudflareWorkerScriptExists({
					...input,
					scriptName: productionPlatformScriptName,
				}),
				getCloudflareWorkerScriptExists({
					...input,
					scriptName: productionRuntimeScriptName,
				}),
			])
		let namespaces: Array<DurableObjectNamespaceOwnership> | null = null
		try {
			namespaces = await listCloudflareDurableObjectNamespaces(input)
		} catch (error) {
			console.error(
				`Durable Object namespace listing failed; classifying from script existence only. ${error instanceof Error ? error.message : String(error)}`,
			)
		}
		return classifyOriginProductionScriptState({
			originScriptExists,
			platformScriptExists,
			runtimeScriptExists,
			namespaces,
		})
	} catch (error) {
		return {
			mode: 'ambiguous',
			reason: `Cloudflare script probe failed (${error instanceof Error ? error.message : String(error)}); keep the full entry and do not bootstrap transfers.`,
		}
	}
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null
	return value as Record<string, unknown>
}

/**
 * Preview-style first origin deploy: the script must locally own every
 * transferred class so `new_sqlite_classes` can create them before
 * platform/runtime `transferred_classes` runs.
 */
export function stripOriginCrossScriptClassBindings(
	config: Record<string, unknown>,
	scriptNames: ReadonlySet<string> = new Set([
		productionPlatformScriptName,
		productionRuntimeScriptName,
	]),
) {
	const env = asRecord(config.env)
	const productionEnv = env ? asRecord(env.production) : null
	const targets = [config, productionEnv].filter(
		(entry): entry is Record<string, unknown> => entry !== null,
	)
	for (const target of targets) {
		const durableObjects = asRecord(target.durable_objects)
		const bindings = durableObjects?.bindings
		if (Array.isArray(bindings)) {
			for (const entry of bindings) {
				const binding = asRecord(entry)
				if (!binding) continue
				if (
					typeof binding.script_name === 'string' &&
					scriptNames.has(binding.script_name)
				) {
					delete binding.script_name
				}
			}
		}
		const workflows = target.workflows
		if (Array.isArray(workflows)) {
			for (const entry of workflows) {
				const workflow = asRecord(entry)
				if (!workflow) continue
				if (
					typeof workflow.script_name === 'string' &&
					scriptNames.has(workflow.script_name)
				) {
					delete workflow.script_name
				}
			}
		}
	}
	return config
}

export async function writeOriginBootstrapWranglerConfig(input: {
	generatedConfig: Record<string, unknown>
	outConfigPath: string
}) {
	const bootstrap = structuredClone(input.generatedConfig)
	bootstrap.main = defaultDevEntryPath
	stripOriginCrossScriptClassBindings(bootstrap)
	const resolvedOut = path.resolve(input.outConfigPath)
	await writeFile(
		resolvedOut,
		`${JSON.stringify(bootstrap, null, '\t')}\n`,
		'utf8',
	)
	return resolvedOut
}
