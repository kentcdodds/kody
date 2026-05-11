import { type ContentBlock } from '@modelcontextprotocol/sdk/types.js'
import { toHex } from '@kody-internal/shared/hex.ts'
import { type RemoteConnectorRef } from '@kody-internal/shared/remote-connectors.ts'
import { extractRawContent, getExecutionErrorDetails } from '#mcp/executor.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { getErrorMessage } from '#mcp/capabilities/error-message.ts'
import {
	runBundledModuleWithRegistry,
	type PackageInvokeCheckResult,
	type PackageInvokeContract,
	type PackageInvokeInput,
	type PackageInvokeNormalizedInput,
	type PackageInvokeTools,
} from '#mcp/run-codemode-registry.ts'
import {
	type PackageRuntimeDebugContext,
	type PackageRuntimeSurface,
} from '#worker/package-runtime/package-runtime-debug.ts'
import {
	getSavedPackageById,
	getSavedPackageByKodyId,
} from '#worker/package-registry/repo.ts'
import {
	loadPackageManifestBySourceId,
	loadPackageSourceBySourceId,
} from '#worker/package-registry/source.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import {
	buildPackageSearchProjection,
	normalizePackageWorkspacePath,
	resolvePackageExportPath,
	type PackageExportProjection,
} from '#worker/package-registry/manifest.ts'
import { typecheckPackageEntrypointsFromSourceFiles } from '#worker/repo/checks.ts'
import {
	loadPublishedBundleArtifactByIdentity,
	persistPublishedBundleArtifact,
} from '#worker/package-runtime/published-bundle-artifacts.ts'
import { packageWorkflowInvocationSource } from '#worker/package-runtime/package-invocation-sources.ts'
import { assertPublishedSourceCanRebuildWithoutInstallingDeps } from '#worker/package-runtime/published-source-dependencies.ts'
import {
	buildPackageSubscriptionArtifactName,
	normalizePackageSubscriptionTopic,
} from '#worker/package-runtime/subscription-artifacts.ts'
import { getEntitySourceById } from '#worker/repo/entity-sources.ts'
import { type EntitySourceRow } from '#worker/repo/types.ts'
import {
	getEmailAttachmentById,
	getEmailMessageById,
	getEmailMessageWithAttachmentsById,
} from '#worker/email/repo.ts'
import {
	getPackageInvocationByKey,
	insertPackageInvocationRow,
	updatePackageInvocationResult,
	type PackageInvocationStoredResponse,
} from './repo.ts'

export type PackageInvocationTokenScope = {
	tokenId: string
	userId: string
	email: string
	displayName: string
	packageIds?: Array<string>
	packageKodyIds?: Array<string>
	exportNames?: Array<string>
	sources?: Array<string>
	remoteConnectors?: Array<RemoteConnectorRef>
}

export type PackageInvocationRequest = {
	packageIdOrKodyId: string
	exportName: string
	params?: Record<string, unknown>
	idempotencyKey: string
	source?: string | null
	topic?: string | null
}

export type PackageInvocationResponse = PackageInvocationStoredResponse

type PackageInvocationActor = {
	tokenId: string
	userId: string
	email: string
	displayName: string
	remoteConnectors?: Array<RemoteConnectorRef> | null
}

type PackageModuleSelector =
	| {
			kind: 'export'
			exportName: string
	  }
	| {
			kind: 'subscription'
			topic: string
	  }

type PackageModuleResolution = {
	artifactName: string
	entryPoint: string
}

type PackageRuntimeContext = {
	packageId: string
	kodyId: string
	sourceId?: string | null
}

const internalEmailSubscriptionTokenId = 'internal:email-subscriptions'
const internalPackageRuntimeInvokeTokenId = 'internal:package-runtime'
const maxPackageRuntimeInvokeDepth = 8

function normalizeExportName(exportName: string) {
	const trimmed = exportName.trim()
	if (!trimmed) {
		throw new Error('Package export name must not be empty.')
	}
	if (trimmed === '.' || trimmed === './') {
		return '.'
	}
	return trimmed.startsWith('./') ? trimmed : `./${trimmed}`
}

function normalizeNullableString(value: string | null | undefined) {
	const trimmed = value?.trim()
	return trimmed && trimmed.length > 0 ? trimmed : null
}

function readOptionalString(
	input: PackageInvokeInput,
	fieldNames: Array<string>,
) {
	for (const fieldName of fieldNames) {
		const value = input[fieldName]
		if (typeof value === 'string' && value.trim()) return value.trim()
	}
	return null
}

function readSinglePackageIdentifier(
	input: PackageInvokeInput,
	operationName = 'packages.invoke',
) {
	const candidates = [
		{
			kind: 'kodyId' as const,
			value: readOptionalString(input, ['kodyId', 'kody_id']),
		},
		{
			kind: 'packageId' as const,
			value: readOptionalString(input, ['packageId', 'package_id']),
		},
	].filter(
		(candidate): candidate is { kind: 'kodyId' | 'packageId'; value: string } =>
			candidate.value !== null,
	)
	const unique = Array.from(
		new Set(candidates.map((candidate) => candidate.value)),
	)
	if (unique.length > 1) {
		throw new Error(
			`${operationName} accepts one package identifier. Use kodyId unless you need the saved package id.`,
		)
	}
	const [identifier] = candidates
	if (!identifier) {
		throw new Error(`${operationName} requires kodyId or packageId.`)
	}
	return identifier
}

function readPackageInvokeParams(
	input: PackageInvokeInput,
	operationName = 'packages.invoke',
) {
	const params = input['params']
	if (params === undefined || params === null) return undefined
	if (!params || typeof params !== 'object' || Array.isArray(params)) {
		throw new Error(
			`${operationName} params must be a JSON object when provided.`,
		)
	}
	return params as Record<string, unknown>
}

function parsePackageInvokeInput(
	input: PackageInvokeInput,
	operationName = 'packages.invoke',
) {
	const packageIdentifier = readSinglePackageIdentifier(input, operationName)
	const exportName = readOptionalString(input, ['exportName', 'export_name'])
	if (!exportName) {
		throw new Error(`${operationName} requires exportName.`)
	}
	return {
		packageIdentifier,
		packageIdOrKodyId: packageIdentifier.value,
		exportName,
		params: readPackageInvokeParams(input, operationName),
		idempotencyKey: readOptionalString(input, [
			'idempotencyKey',
			'idempotency_key',
		]),
		topic: readOptionalString(input, ['topic']),
	}
}

function buildPackageInvocationStorageId(packageId: string) {
	return `package:${encodeURIComponent(packageId)}`
}

function createRepoContext(source: EntitySourceRow) {
	return {
		sourceId: source.id,
		repoId: source.repo_id,
		sessionId: null,
		sessionRepoId: null,
		baseCommit: source.published_commit,
		manifestPath: source.manifest_path,
		sourceRoot: source.source_root,
		publishedCommit: source.published_commit,
		entityKind: source.entity_kind,
		entityId: source.entity_id,
	}
}

function toJsonSafeValue(value: unknown): unknown {
	try {
		return JSON.parse(JSON.stringify(value)) as unknown
	} catch {
		return value instanceof Error ? value.message : String(value)
	}
}

function markStoredResponseAsReplayed(
	response: PackageInvocationStoredResponse,
) {
	const body = structuredClone(response.body)
	const record = body as Record<string, unknown>
	const existingIdempotency = record['idempotency']
	if (existingIdempotency && typeof existingIdempotency === 'object') {
		record['idempotency'] = {
			...(existingIdempotency as Record<string, unknown>),
			replayed: true,
		}
	} else {
		record['idempotency'] = { replayed: true }
	}
	return {
		status: response.status,
		body,
	} satisfies PackageInvocationStoredResponse
}

async function createRequestHash(input: {
	packageId: string
	exportName: string
	params?: Record<string, unknown>
	source: string | null
	topic: string | null
}) {
	const canonical = canonicalJsonStringify(input)
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(canonical),
	)
	return toHex(new Uint8Array(digest))
}

function canonicalJsonStringify(value: unknown): string {
	return JSON.stringify(canonicalizeJsonValue(value))
}

function canonicalizeJsonValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map((entry) => canonicalizeJsonValue(entry))
	}
	if (value && typeof value === 'object') {
		const record = value as Record<string, unknown>
		return Object.fromEntries(
			Object.keys(record)
				.sort((left, right) => left.localeCompare(right))
				.map((key) => [key, canonicalizeJsonValue(record[key])]),
		)
	}
	return value
}

async function createAutoPackageInvokeIdempotencyKey(input: {
	callerPackageContext: PackageRuntimeContext
	parentRuntimeDebug: PackageRuntimeDebugContext | null
	sequence: number
	request: ReturnType<typeof parsePackageInvokeInput>
}) {
	const parentKey = input.parentRuntimeDebug?.idempotencyKey?.trim()
	if (!parentKey) {
		return `pkginvoke:${crypto.randomUUID()}`
	}
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(
			canonicalJsonStringify({
				callerPackageId: input.callerPackageContext.packageId,
				parentKey,
				parentSurface: input.parentRuntimeDebug?.surface ?? null,
				parentName: input.parentRuntimeDebug?.name ?? null,
				sequence: input.sequence,
				packageIdOrKodyId: input.request.packageIdOrKodyId,
				exportName: normalizeExportName(input.request.exportName),
				params: input.request.params,
				topic: input.request.topic,
			}),
		),
	)
	return [
		'pkginvoke',
		input.callerPackageContext.packageId,
		parentKey,
		String(input.sequence),
		toHex(new Uint8Array(digest)).slice(0, 24),
	].join(':')
}

function createPackageInvokeCheckFailure(input: {
	message: string
	problems: Array<string>
	contract?: Partial<PackageInvokeContract>
}): PackageInvokeCheckResult {
	return {
		ok: false,
		message: input.message,
		problems: input.problems,
		...(input.contract ? { contract: input.contract } : {}),
	}
}

function buildNormalizedPackageInvokeInput(input: {
	request: ReturnType<typeof parsePackageInvokeInput>
	exportName: string
}): PackageInvokeNormalizedInput {
	return {
		...(input.request.packageIdentifier.kind === 'kodyId'
			? { kodyId: input.request.packageIdentifier.value }
			: { packageId: input.request.packageIdentifier.value }),
		exportName: input.exportName,
		...(input.request.params === undefined
			? {}
			: { params: input.request.params }),
		...(input.request.idempotencyKey
			? { idempotencyKey: input.request.idempotencyKey }
			: {}),
		...(input.request.topic ? { topic: input.request.topic } : {}),
	}
}

function findPackageExportProjection(input: {
	exports: Array<PackageExportProjection>
	exportName: string
}) {
	return (
		input.exports.find(
			(exportDetail) => exportDetail.subpath === input.exportName,
		) ?? null
	)
}

function buildPackageInvokeCheckWarnings(input: {
	exportDetail: PackageExportProjection | null
	sourceLoadFailed: boolean
}) {
	const warnings = [
		'No machine-readable params schema is published for package exports; params were only validated as a JSON object.',
	]
	if (input.sourceLoadFailed) {
		warnings.push(
			'Source files could not be loaded for metadata extraction; description and type information may be incomplete.',
		)
	}
	if (!input.exportDetail?.typeDefinition) {
		warnings.push(
			'No function type definition was found for this export; callable shape could not be statically confirmed.',
		)
	}
	return warnings
}

async function checkPackageInvokeForRuntime(input: {
	env: Env
	baseUrl: string
	operationName: 'packages.check' | 'packages.invokeChecked'
	userId: string
	rawInput: PackageInvokeInput
}): Promise<PackageInvokeCheckResult> {
	let request: ReturnType<typeof parsePackageInvokeInput>
	try {
		request = parsePackageInvokeInput(input.rawInput, input.operationName)
	} catch (error) {
		const message = getErrorMessage(error)
		return createPackageInvokeCheckFailure({
			message,
			problems: [message],
		})
	}
	const exportName = normalizeExportName(request.exportName)
	const invoke = buildNormalizedPackageInvokeInput({ request, exportName })
	const savedPackage = await resolveSavedPackage({
		db: input.env.APP_DB,
		userId: input.userId,
		packageIdOrKodyId: request.packageIdOrKodyId,
	})
	if (!savedPackage) {
		const message = `Saved package "${request.packageIdOrKodyId}" was not found for this user.`
		return createPackageInvokeCheckFailure({
			message,
			problems: [message],
			contract: { exportName },
		})
	}
	const packageContract = {
		packageId: savedPackage.id,
		kodyId: savedPackage.kodyId,
		name: savedPackage.name,
		sourceId: savedPackage.sourceId,
		exportName,
	}
	let manifestResult: Awaited<ReturnType<typeof loadPackageManifestBySourceId>>
	try {
		manifestResult = await loadPackageManifestBySourceId({
			env: input.env,
			baseUrl: input.baseUrl,
			userId: input.userId,
			sourceId: savedPackage.sourceId,
		})
	} catch (error) {
		const problem = `Could not load current package manifest: ${getErrorMessage(error)}`
		return createPackageInvokeCheckFailure({
			message: problem,
			problems: [problem],
			contract: packageContract,
		})
	}
	let resolution: PackageModuleResolution
	try {
		resolution = resolvePackageModuleResolution({
			manifest: manifestResult.manifest,
			selector: {
				kind: 'export',
				exportName,
			},
		})
	} catch (error) {
		const problem = getErrorMessage(error)
		return createPackageInvokeCheckFailure({
			message: problem,
			problems: [problem],
			contract: {
				...packageContract,
				publishedCommit: manifestResult.source.published_commit ?? null,
			},
		})
	}
	try {
		await ensureModuleArtifact({
			env: input.env,
			baseUrl: input.baseUrl,
			packageManifest: manifestResult,
			resolution,
			savedPackage,
			selector: {
				kind: 'export',
				exportName,
			},
			userId: input.userId,
		})
	} catch (error) {
		const problem = `Export "${exportName}" could not be prepared for invocation: ${getErrorMessage(error)}`
		return createPackageInvokeCheckFailure({
			message: problem,
			problems: [problem],
			contract: {
				...packageContract,
				publishedCommit: manifestResult.source.published_commit ?? null,
				runtimeTarget: resolution.entryPoint,
			},
		})
	}
	let files: Record<string, string> | undefined
	let sourceLoadFailed = false
	try {
		files = (
			await loadPackageSourceBySourceId({
				env: input.env,
				baseUrl: input.baseUrl,
				userId: input.userId,
				sourceId: savedPackage.sourceId,
			})
		).files
	} catch {
		sourceLoadFailed = true
	}
	const projection = buildPackageSearchProjection(
		manifestResult.manifest,
		files,
	)
	const exportDetail = findPackageExportProjection({
		exports: projection.exports,
		exportName,
	})
	const warnings = buildPackageInvokeCheckWarnings({
		exportDetail,
		sourceLoadFailed,
	})
	return {
		ok: true,
		invoke,
		contract: {
			...packageContract,
			publishedCommit: manifestResult.source.published_commit ?? null,
			runtimeTarget: exportDetail?.runtimeTarget ?? resolution.entryPoint,
			description: exportDetail?.description ?? null,
			typeDefinition: exportDetail?.typeDefinition ?? null,
			warnings,
		},
	}
}

async function resolveSavedPackage(input: {
	db: D1Database
	userId: string
	packageIdOrKodyId: string
}): Promise<SavedPackageRecord | null> {
	return (
		(await getSavedPackageById(input.db, {
			userId: input.userId,
			packageId: input.packageIdOrKodyId,
		})) ??
		(await getSavedPackageByKodyId(input.db, {
			userId: input.userId,
			kodyId: input.packageIdOrKodyId,
		}))
	)
}

function tokenAllowsPackage(input: {
	token: PackageInvocationTokenScope
	savedPackage: SavedPackageRecord
}) {
	const allowsPackageId =
		input.token.packageIds?.includes(input.savedPackage.id) ?? false
	const allowsKodyId =
		input.token.packageKodyIds?.includes(input.savedPackage.kodyId) ?? false
	return allowsPackageId || allowsKodyId
}

function tokenAllowsExport(input: {
	token: PackageInvocationTokenScope
	exportName: string
}) {
	const exportNames = input.token.exportNames ?? []
	return exportNames
		.map((entry) => normalizeExportName(entry))
		.includes(input.exportName)
}

function tokenAllowsSource(input: {
	token: PackageInvocationTokenScope
	source: string | null
}) {
	if (!input.source) return true
	const sources = input.token.sources ?? []
	return sources.includes(input.source)
}

async function ensureModuleArtifact(input: {
	env: Env
	baseUrl: string
	packageManifest?: Awaited<ReturnType<typeof loadPackageManifestBySourceId>>
	resolution?: PackageModuleResolution
	savedPackage: SavedPackageRecord
	selector: PackageModuleSelector
	userId: string
}) {
	const packageManifest =
		input.packageManifest ??
		(await loadPackageManifestBySourceId({
			env: input.env,
			baseUrl: input.baseUrl,
			userId: input.userId,
			sourceId: input.savedPackage.sourceId,
		}))
	const resolution =
		input.resolution ??
		resolvePackageModuleResolution({
			manifest: packageManifest.manifest,
			selector: input.selector,
		})
	const loaded = await loadPublishedBundleArtifactByIdentity({
		env: input.env,
		userId: input.userId,
		sourceId: input.savedPackage.sourceId,
		kind: 'module',
		artifactName: resolution.artifactName,
		entryPoint: resolution.entryPoint,
	})
	if (loaded?.artifact) {
		return {
			artifact: loaded.artifact,
			source: packageManifest.source,
			entryPoint: resolution.entryPoint,
		}
	}
	const packageSource = await loadPackageSourceBySourceId({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.userId,
		sourceId: input.savedPackage.sourceId,
	})
	const typecheckResult = await typecheckPackageEntrypointsFromSourceFiles({
		sourceFiles: packageSource.files,
		entryPoints: [{ path: resolution.entryPoint, includeStorage: true }],
	})
	if (!typecheckResult.ok) {
		throw new Error(typecheckResult.message)
	}
	assertPublishedSourceCanRebuildWithoutInstallingDeps({
		sourceFiles: packageSource.files,
		bundleLabel: `Saved package export "${resolution.artifactName}"`,
	})
	const { buildKodyModuleBundle } =
		await import('#worker/package-runtime/module-graph.ts')
	const bundle = await buildKodyModuleBundle({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.userId,
		sourceFiles: packageSource.files,
		entryPoint: resolution.entryPoint,
	})
	await persistPublishedBundleArtifact({
		env: input.env,
		userId: input.userId,
		source: packageSource.source,
		kind: 'module',
		artifactName: resolution.artifactName,
		entryPoint: resolution.entryPoint,
		mainModule: bundle.mainModule,
		modules: bundle.modules,
		dependencies: bundle.dependencies,
		packageContext: {
			packageId: input.savedPackage.id,
			kodyId: input.savedPackage.kodyId,
			sourceId: input.savedPackage.sourceId,
		},
	})
	const rebuilt = await loadPublishedBundleArtifactByIdentity({
		env: input.env,
		userId: input.userId,
		sourceId: input.savedPackage.sourceId,
		kind: 'module',
		artifactName: resolution.artifactName,
		entryPoint: resolution.entryPoint,
	})
	if (!rebuilt?.artifact) {
		const moduleLabel =
			input.selector.kind === 'export'
				? `export "${input.selector.exportName}"`
				: `subscription "${input.selector.topic}"`
		throw new Error(
			`Published bundle artifact for ${moduleLabel} could not be loaded after rebuild.`,
		)
	}
	return {
		artifact: rebuilt.artifact,
		source: packageSource.source,
		entryPoint: resolution.entryPoint,
	}
}

function buildExecutionSuccessResponse(input: {
	savedPackage: SavedPackageRecord
	invocationName: string
	idempotencyKey: string
	source: string | null
	topic: string | null
	result: unknown
	logs: Array<string>
	rawContent: Array<ContentBlock> | null
}): PackageInvocationStoredResponse {
	return {
		status: 200,
		body: {
			ok: true,
			package: {
				id: input.savedPackage.id,
				kodyId: input.savedPackage.kodyId,
			},
			exportName: input.invocationName,
			source: input.source,
			topic: input.topic,
			idempotency: {
				key: input.idempotencyKey,
				replayed: false,
			},
			result: toJsonSafeValue(input.result),
			logs: input.logs,
			...(input.rawContent
				? { rawContent: toJsonSafeValue(input.rawContent) }
				: {}),
		},
	}
}

function buildExecutionErrorResponse(input: {
	savedPackage: SavedPackageRecord
	invocationName: string
	idempotencyKey: string
	source: string | null
	topic: string | null
	error: unknown
	logs: Array<string>
}): PackageInvocationStoredResponse {
	const message =
		input.error instanceof Error ? input.error.message : String(input.error)
	return {
		status: 500,
		body: {
			ok: false,
			package: {
				id: input.savedPackage.id,
				kodyId: input.savedPackage.kodyId,
			},
			exportName: input.invocationName,
			source: input.source,
			topic: input.topic,
			idempotency: {
				key: input.idempotencyKey,
				replayed: false,
			},
			error: {
				code: 'execution_failed',
				message,
				details: toJsonSafeValue(getExecutionErrorDetails(input.error)),
			},
			logs: input.logs,
		},
	}
}

function buildJsonErrorResponse(input: {
	status: number
	code: string
	message: string
	idempotencyKey?: string
	replayed?: boolean
}) {
	return {
		status: input.status,
		body: {
			ok: false,
			error: {
				code: input.code,
				message: input.message,
			},
			...(input.idempotencyKey
				? {
						idempotency: {
							key: input.idempotencyKey,
							replayed: input.replayed ?? false,
						},
					}
				: {}),
		},
	} satisfies PackageInvocationStoredResponse
}

function buildIdempotencyResponseUnavailable(input: {
	idempotencyKey: string
}) {
	return buildJsonErrorResponse({
		status: 409,
		code: 'idempotency_response_unavailable',
		message:
			'This idempotency key already has a terminal invocation record, but its stored response could not be replayed.',
		idempotencyKey: input.idempotencyKey,
	})
}

function resolveExistingInvocation(input: {
	record: NonNullable<Awaited<ReturnType<typeof getPackageInvocationByKey>>>
	requestHash: string
	idempotencyKey: string
}): PackageInvocationStoredResponse {
	if (input.record.request_hash !== input.requestHash) {
		return buildJsonErrorResponse({
			status: 409,
			code: 'idempotency_mismatch',
			message:
				'This idempotency key has already been used for a different package invocation request.',
			idempotencyKey: input.idempotencyKey,
		})
	}
	if (input.record.status === 'in_progress') {
		return buildJsonErrorResponse({
			status: 409,
			code: 'invocation_in_progress',
			message:
				'This idempotency key is already processing for the requested package export.',
			idempotencyKey: input.idempotencyKey,
		})
	}
	if (input.record.storedResponse) {
		return markStoredResponseAsReplayed(input.record.storedResponse)
	}
	return buildIdempotencyResponseUnavailable({
		idempotencyKey: input.idempotencyKey,
	})
}

function resolvePackageModuleResolution(input: {
	manifest: Awaited<ReturnType<typeof loadPackageSourceBySourceId>>['manifest']
	selector: PackageModuleSelector
}): PackageModuleResolution {
	switch (input.selector.kind) {
		case 'export': {
			const exportName = normalizeExportName(input.selector.exportName)
			return {
				artifactName: exportName,
				entryPoint: resolvePackageExportPath({
					manifest: input.manifest,
					exportName,
				}),
			}
		}
		case 'subscription': {
			const topic = normalizePackageSubscriptionTopic(input.selector.topic)
			const handler = input.manifest.kody.subscriptions?.[topic]?.handler
			if (!handler) {
				throw new Error(
					`Package "${input.manifest.kody.id}" does not define subscription "${topic}".`,
				)
			}
			return {
				artifactName: buildPackageSubscriptionArtifactName(topic),
				entryPoint: normalizePackageWorkspacePath(handler),
			}
		}
		default: {
			const selector = input.selector
			void selector
			throw new Error('Unhandled package module selector.')
		}
	}
}

function isMissingPackageModuleError(error: unknown) {
	return (
		error instanceof Error &&
		(error.message.includes('does not define export') ||
			error.message.includes('does not define a runtime target') ||
			error.message.includes('does not define subscription'))
	)
}

function resolveInvocationRuntimeSurface(input: {
	selector: PackageModuleSelector
	source: string | null
}): PackageRuntimeSurface {
	if (input.source === packageWorkflowInvocationSource) return 'workflow'
	switch (input.selector.kind) {
		case 'export':
			return 'export'
		case 'subscription':
			return 'subscription'
		default: {
			const selector: never = input.selector
			void selector
			throw new Error('Unhandled package module selector.')
		}
	}
}

function resolveInvocationRuntimeName(input: {
	surface: PackageRuntimeSurface
	invocationName: string
	topic: string | null
}) {
	switch (input.surface) {
		case 'workflow':
		case 'subscription':
			return input.topic ?? input.invocationName
		case 'export':
			return input.invocationName
		case 'app_fetch':
		case 'app_realtime':
		case 'service':
		case 'job':
		case 'retriever':
			return input.invocationName
		default: {
			const surface: never = input.surface
			void surface
			throw new Error('Unhandled package runtime surface.')
		}
	}
}

async function invokeSavedPackageModule(input: {
	env: Env
	baseUrl: string
	actor: PackageInvocationActor
	savedPackage: SavedPackageRecord
	invocationName: string
	moduleSelector: PackageModuleSelector
	params?: Record<string, unknown>
	idempotencyKey: string
	source: string | null
	topic: string | null
	notFoundCode: 'export_not_found' | 'subscription_not_found'
	runtimeInvokeDepth?: number
}) {
	const requestHash = await createRequestHash({
		packageId: input.savedPackage.id,
		exportName: input.invocationName,
		params: input.params,
		source: input.source,
		topic: input.topic,
	})
	let existing: Awaited<ReturnType<typeof getPackageInvocationByKey>>
	try {
		existing = await getPackageInvocationByKey({
			db: input.env.APP_DB,
			userId: input.actor.userId,
			tokenId: input.actor.tokenId,
			packageId: input.savedPackage.id,
			exportName: input.invocationName,
			idempotencyKey: input.idempotencyKey,
		})
	} catch (error) {
		console.error('package invocation idempotency lookup failed', error)
		return buildJsonErrorResponse({
			status: 500,
			code: 'idempotency_lookup_failed',
			message:
				'Unable to look up the package invocation idempotency record. Please retry.',
			idempotencyKey: input.idempotencyKey,
		})
	}
	if (existing) {
		return resolveExistingInvocation({
			record: existing,
			requestHash,
			idempotencyKey: input.idempotencyKey,
		})
	}

	const invocationId = crypto.randomUUID()
	let inserted: boolean
	try {
		inserted = await insertPackageInvocationRow({
			db: input.env.APP_DB,
			row: {
				id: invocationId,
				userId: input.actor.userId,
				tokenId: input.actor.tokenId,
				packageId: input.savedPackage.id,
				packageKodyId: input.savedPackage.kodyId,
				exportName: input.invocationName,
				idempotencyKey: input.idempotencyKey,
				requestHash,
				source: input.source,
				topic: input.topic,
				status: 'in_progress',
			},
		})
	} catch (error) {
		console.error('package invocation idempotency persistence failed', error)
		return buildJsonErrorResponse({
			status: 500,
			code: 'idempotency_persistence_failed',
			message:
				'Unable to persist the package invocation idempotency record. Please retry.',
			idempotencyKey: input.idempotencyKey,
		})
	}
	if (!inserted) {
		let current: Awaited<ReturnType<typeof getPackageInvocationByKey>>
		try {
			current = await getPackageInvocationByKey({
				db: input.env.APP_DB,
				userId: input.actor.userId,
				tokenId: input.actor.tokenId,
				packageId: input.savedPackage.id,
				exportName: input.invocationName,
				idempotencyKey: input.idempotencyKey,
			})
		} catch (error) {
			console.error('package invocation idempotency lookup failed', error)
			return buildJsonErrorResponse({
				status: 500,
				code: 'idempotency_lookup_failed',
				message:
					'Unable to look up the package invocation idempotency record. Please retry.',
				idempotencyKey: input.idempotencyKey,
			})
		}
		if (!current) {
			return buildJsonErrorResponse({
				status: 500,
				code: 'idempotency_conflict_unresolved',
				message:
					'Package invocation idempotency insert conflicted but no existing row was found.',
				idempotencyKey: input.idempotencyKey,
			})
		}
		return resolveExistingInvocation({
			record: current,
			requestHash,
			idempotencyKey: input.idempotencyKey,
		})
	}

	try {
		const { artifact, source: sourceRow } = await ensureModuleArtifact({
			env: input.env,
			baseUrl: input.baseUrl,
			savedPackage: input.savedPackage,
			selector: input.moduleSelector,
			userId: input.actor.userId,
		})
		const repoSource =
			artifact.packageContext?.sourceId != null
				? await getEntitySourceById(
						input.env.APP_DB,
						artifact.packageContext.sourceId,
					)
				: sourceRow
		const callerContext = createMcpCallerContext({
			baseUrl: input.baseUrl,
			user: {
				userId: input.actor.userId,
				email: input.actor.email,
				displayName: input.actor.displayName,
			},
			storageContext: {
				sessionId: null,
				appId: input.savedPackage.id,
				storageId: buildPackageInvocationStorageId(input.savedPackage.id),
			},
			remoteConnectors: input.actor.remoteConnectors ?? null,
			repoContext: repoSource ? createRepoContext(repoSource) : null,
		})
		const runtimeSurface = resolveInvocationRuntimeSurface({
			selector: input.moduleSelector,
			source: input.source,
		})
		const packageContext = artifact.packageContext ?? {
			packageId: input.savedPackage.id,
			kodyId: input.savedPackage.kodyId,
			sourceId: input.savedPackage.sourceId,
		}
		const runtimeDebug: PackageRuntimeDebugContext = {
			packageId: input.savedPackage.id,
			kodyId: input.savedPackage.kodyId,
			sourceId: input.savedPackage.sourceId,
			publishedCommit: repoSource?.published_commit ?? null,
			surface: runtimeSurface,
			name: resolveInvocationRuntimeName({
				surface: runtimeSurface,
				invocationName: input.invocationName,
				topic: input.topic,
			}),
			invocationId,
			idempotencyKey: input.idempotencyKey,
			metadata: {
				exportName: input.invocationName,
				source: input.source,
				topic: input.topic,
			},
		}
		const executionResult = await runBundledModuleWithRegistry(
			input.env,
			callerContext,
			{
				mainModule: artifact.mainModule,
				modules: artifact.modules,
			},
			input.params,
			{
				storageTools: {
					userId: input.actor.userId,
					storageId: buildPackageInvocationStorageId(input.savedPackage.id),
					writable: true,
				},
				runtimeDebug,
				emailTools: {
					getMessage: async (messageId) => {
						const loaded = await getEmailMessageWithAttachmentsById({
							db: input.env.APP_DB,
							userId: input.actor.userId,
							messageId,
						})
						if (!loaded) {
							throw new Error(`Email message not found: ${messageId}`)
						}
						return {
							id: loaded.message.id,
							direction: loaded.message.direction,
							inbox_id: loaded.message.inboxId,
							thread_id: loaded.message.threadId,
							from_address: loaded.message.fromAddress,
							envelope_from: loaded.message.envelopeFrom,
							to_addresses: loaded.message.toAddresses,
							cc_addresses: loaded.message.ccAddresses,
							bcc_addresses: loaded.message.bccAddresses,
							reply_to_addresses: loaded.message.replyToAddresses,
							subject: loaded.message.subject,
							message_id_header: loaded.message.messageIdHeader,
							in_reply_to_header: loaded.message.inReplyToHeader,
							references: loaded.message.references,
							headers: loaded.message.headers,
							auth_results: loaded.message.authResults,
							text_body: loaded.message.textBody,
							html_body: loaded.message.htmlBody,
							raw_size: loaded.message.rawSize,
							processing_status: loaded.message.processingStatus,
							provider_message_id: loaded.message.providerMessageId,
							error: loaded.message.error,
							received_at: loaded.message.receivedAt,
							sent_at: loaded.message.sentAt,
							created_at: loaded.message.createdAt,
							updated_at: loaded.message.updatedAt,
							attachments: loaded.attachments.map((attachment) => ({
								id: attachment.id,
								filename: attachment.filename,
								content_type: attachment.contentType,
								content_id: attachment.contentId,
								disposition: attachment.disposition,
								size: attachment.size,
								storage_kind: attachment.storageKind,
								storage_key: attachment.storageKey,
								created_at: attachment.createdAt,
							})),
						}
					},
					getAttachment: async (attachmentId) => {
						const attachment = await getEmailAttachmentById({
							db: input.env.APP_DB,
							userId: input.actor.userId,
							attachmentId,
						})
						if (!attachment) {
							throw new Error(`Email attachment not found: ${attachmentId}`)
						}
						const message = await getEmailMessageById({
							db: input.env.APP_DB,
							userId: input.actor.userId,
							messageId: attachment.messageId,
						})
						if (!message) {
							throw new Error(
								`Email message not found for attachment: ${attachment.messageId}`,
							)
						}
						return {
							id: attachment.id,
							message_id: attachment.messageId,
							filename: attachment.filename,
							content_type: attachment.contentType,
							content_id: attachment.contentId,
							disposition: attachment.disposition,
							size: attachment.size,
							storage_kind: attachment.storageKind,
							storage_key: attachment.storageKey,
							created_at: attachment.createdAt,
							message: {
								id: message.id,
								message_id_header: message.messageIdHeader,
								subject: message.subject,
							},
							content: attachment.content,
							content_base64: attachment.contentBase64,
						}
					},
				},
				packageContext,
				packageInvokeTools: createPackageRuntimeInvokeTools({
					env: input.env,
					baseUrl: input.baseUrl,
					callerContext,
					packageContext,
					parentRuntimeDebug: runtimeDebug,
					packageInvokeDepth: input.runtimeInvokeDepth ?? 0,
				}),
			},
		)
		const response = executionResult.error
			? buildExecutionErrorResponse({
					savedPackage: input.savedPackage,
					invocationName: input.invocationName,
					idempotencyKey: input.idempotencyKey,
					source: input.source,
					topic: input.topic,
					error: executionResult.error,
					logs: executionResult.logs ?? [],
				})
			: buildExecutionSuccessResponse({
					savedPackage: input.savedPackage,
					invocationName: input.invocationName,
					idempotencyKey: input.idempotencyKey,
					source: input.source,
					topic: input.topic,
					result: executionResult.result,
					logs: executionResult.logs ?? [],
					rawContent: extractRawContent(executionResult.result),
				})
		await updatePackageInvocationResult({
			db: input.env.APP_DB,
			id: invocationId,
			userId: input.actor.userId,
			status: executionResult.error ? 'failed' : 'completed',
			response,
		})
		return response
	} catch (error) {
		if (isMissingPackageModuleError(error)) {
			const response = buildJsonErrorResponse({
				status: 404,
				code: input.notFoundCode,
				message: error instanceof Error ? error.message : String(error),
				idempotencyKey: input.idempotencyKey,
			})
			await updatePackageInvocationResult({
				db: input.env.APP_DB,
				id: invocationId,
				userId: input.actor.userId,
				status: 'failed',
				response,
			}).catch(() => {
				// Best effort; preserve the original invocation error.
			})
			return response
		}
		const response = buildJsonErrorResponse({
			status: 500,
			code: 'invocation_failed',
			message: error instanceof Error ? error.message : String(error),
			idempotencyKey: input.idempotencyKey,
		})
		await updatePackageInvocationResult({
			db: input.env.APP_DB,
			id: invocationId,
			userId: input.actor.userId,
			status: 'failed',
			response,
		}).catch(() => {
			// Best effort; preserve the original invocation error.
		})
		return response
	}
}

export function createPackageRuntimeInvokeTools(input: {
	env: Env
	baseUrl: string
	callerContext: ReturnType<typeof createMcpCallerContext>
	packageContext: PackageRuntimeContext | null
	parentRuntimeDebug?: PackageRuntimeDebugContext | null
	packageInvokeDepth?: number
}): PackageInvokeTools {
	let autoIdempotencySequence = 0
	const requireRuntimeCaller = (operationName: string) => {
		const user = input.callerContext.user
		if (!user?.userId) {
			throw new Error(`${operationName} requires an authenticated user.`)
		}
		if (!input.packageContext) {
			throw new Error(`${operationName} requires a package runtime context.`)
		}
		return { user, packageContext: input.packageContext }
	}
	const invoke = async (rawInput: PackageInvokeInput) => {
		const { user, packageContext } = requireRuntimeCaller('packages.invoke')
		const packageInvokeDepth = input.packageInvokeDepth ?? 0
		if (packageInvokeDepth >= maxPackageRuntimeInvokeDepth) {
			throw new Error(
				`packages.invoke exceeded the maximum nested invocation depth (${maxPackageRuntimeInvokeDepth}).`,
			)
		}
		const request = parsePackageInvokeInput(rawInput)
		autoIdempotencySequence += 1
		const idempotencyKey =
			request.idempotencyKey ??
			(await createAutoPackageInvokeIdempotencyKey({
				callerPackageContext: packageContext,
				parentRuntimeDebug: input.parentRuntimeDebug ?? null,
				sequence: autoIdempotencySequence,
				request,
			}))
		const response = await invokePackageExportForPackageRuntime({
			env: input.env,
			baseUrl: input.baseUrl,
			caller: {
				userId: user.userId,
				email: user.email ?? '',
				displayName: user.displayName ?? '',
				remoteConnectors: input.callerContext.remoteConnectors ?? null,
				packageContext,
			},
			request: {
				packageIdOrKodyId: request.packageIdOrKodyId,
				exportName: request.exportName,
				params: request.params,
				idempotencyKey,
				source: `package:${packageContext.kodyId}`,
				topic: request.topic,
			},
			runtimeInvokeDepth: packageInvokeDepth + 1,
		})
		if (response.status >= 200 && response.status < 400) {
			return response.body['result']
		}
		const errorRecord =
			(response.body['error'] as Record<string, unknown> | undefined) ?? {}
		const code = String(errorRecord['code'] ?? 'package_invocation_failed')
		const message = String(
			errorRecord['message'] ??
				`Package invocation failed with HTTP ${response.status}.`,
		)
		const error = new Error(`[${code}] ${message}`) as Error & {
			code?: string
			status?: number
			response?: PackageInvocationResponse
		}
		error.code = code
		error.status = response.status
		error.response = response
		throw error
	}
	return {
		check: async (rawInput) => {
			const { user } = requireRuntimeCaller('packages.check')
			return await checkPackageInvokeForRuntime({
				env: input.env,
				baseUrl: input.baseUrl,
				operationName: 'packages.check',
				userId: user.userId,
				rawInput,
			})
		},
		invoke,
		invokeChecked: async (rawInput) => {
			const { user } = requireRuntimeCaller('packages.invokeChecked')
			const check = await checkPackageInvokeForRuntime({
				env: input.env,
				baseUrl: input.baseUrl,
				operationName: 'packages.invokeChecked',
				userId: user.userId,
				rawInput,
			})
			if (!check.ok) {
				const error = new Error(
					`packages.invokeChecked check failed: ${check.message}`,
				) as Error & {
					check?: PackageInvokeCheckResult
				}
				error.check = check
				throw error
			}
			return await invoke(check.invoke)
		},
	}
}

async function invokePackageExportForPackageRuntime(input: {
	env: Env
	baseUrl: string
	caller: {
		userId: string
		email: string
		displayName: string
		remoteConnectors?: Array<RemoteConnectorRef> | null
		packageContext: PackageRuntimeContext
	}
	request: PackageInvocationRequest
	runtimeInvokeDepth?: number
}): Promise<PackageInvocationResponse> {
	const packageIdOrKodyId = input.request.packageIdOrKodyId.trim()
	if (!packageIdOrKodyId) {
		return buildJsonErrorResponse({
			status: 400,
			code: 'invalid_package',
			message: 'Package id or kody id is required.',
		})
	}
	const exportName = normalizeExportName(input.request.exportName)
	const idempotencyKey = input.request.idempotencyKey.trim()
	if (!idempotencyKey) {
		return buildJsonErrorResponse({
			status: 400,
			code: 'missing_idempotency_key',
			message: 'Package invocations require a non-empty idempotencyKey.',
		})
	}
	const savedPackage = await resolveSavedPackage({
		db: input.env.APP_DB,
		userId: input.caller.userId,
		packageIdOrKodyId,
	})
	if (!savedPackage) {
		return buildJsonErrorResponse({
			status: 404,
			code: 'package_not_found',
			message: `Saved package "${packageIdOrKodyId}" was not found for this user.`,
			idempotencyKey,
		})
	}
	return await invokeSavedPackageModule({
		env: input.env,
		baseUrl: input.baseUrl,
		actor: {
			tokenId: `${internalPackageRuntimeInvokeTokenId}:${input.caller.packageContext.packageId}`,
			userId: input.caller.userId,
			email: input.caller.email,
			displayName:
				input.caller.displayName ||
				`package:${input.caller.packageContext.kodyId}`,
			remoteConnectors: input.caller.remoteConnectors ?? null,
		},
		savedPackage,
		invocationName: exportName,
		moduleSelector: {
			kind: 'export',
			exportName,
		},
		params: input.request.params,
		idempotencyKey,
		source:
			normalizeNullableString(input.request.source) ??
			`package:${input.caller.packageContext.kodyId}`,
		topic: normalizeNullableString(input.request.topic),
		notFoundCode: 'export_not_found',
		runtimeInvokeDepth: input.runtimeInvokeDepth ?? 0,
	})
}

export async function invokePackageExport(input: {
	env: Env
	baseUrl: string
	token: PackageInvocationTokenScope
	request: PackageInvocationRequest
	runtimeInvokeDepth?: number
}): Promise<PackageInvocationResponse> {
	const packageIdOrKodyId = input.request.packageIdOrKodyId.trim()
	if (!packageIdOrKodyId) {
		return buildJsonErrorResponse({
			status: 400,
			code: 'invalid_package',
			message: 'Package id or kody id is required.',
		})
	}
	const exportName = normalizeExportName(input.request.exportName)
	const idempotencyKey = input.request.idempotencyKey.trim()
	if (!idempotencyKey) {
		return buildJsonErrorResponse({
			status: 400,
			code: 'missing_idempotency_key',
			message: 'Package invocations require a non-empty idempotencyKey.',
		})
	}
	const source = normalizeNullableString(input.request.source)
	const topic = normalizeNullableString(input.request.topic)
	if (!tokenAllowsSource({ token: input.token, source })) {
		return buildJsonErrorResponse({
			status: 403,
			code: 'source_not_allowed',
			message: 'This token is not allowed to invoke the requested source.',
			idempotencyKey,
		})
	}
	const savedPackage = await resolveSavedPackage({
		db: input.env.APP_DB,
		userId: input.token.userId,
		packageIdOrKodyId,
	})
	if (!savedPackage) {
		return buildJsonErrorResponse({
			status: 404,
			code: 'package_not_found',
			message: `Saved package "${packageIdOrKodyId}" was not found for this user.`,
			idempotencyKey,
		})
	}
	if (!tokenAllowsPackage({ token: input.token, savedPackage })) {
		return buildJsonErrorResponse({
			status: 403,
			code: 'package_not_allowed',
			message: 'This token is not allowed to invoke the requested package.',
			idempotencyKey,
		})
	}
	if (!tokenAllowsExport({ token: input.token, exportName })) {
		return buildJsonErrorResponse({
			status: 403,
			code: 'export_not_allowed',
			message: `This token is not allowed to invoke export "${exportName}".`,
			idempotencyKey,
		})
	}

	return await invokeSavedPackageModule({
		env: input.env,
		baseUrl: input.baseUrl,
		actor: {
			tokenId: input.token.tokenId,
			userId: input.token.userId,
			email: input.token.email,
			displayName: input.token.displayName,
			remoteConnectors: input.token.remoteConnectors ?? null,
		},
		savedPackage,
		invocationName: exportName,
		moduleSelector: {
			kind: 'export',
			exportName,
		},
		params: input.request.params,
		idempotencyKey,
		source,
		topic,
		notFoundCode: 'export_not_found',
		runtimeInvokeDepth: input.runtimeInvokeDepth ?? 0,
	})
}

export async function invokePackageSubscription(input: {
	env: Env
	baseUrl: string
	savedPackage: SavedPackageRecord
	topic: string
	params?: Record<string, unknown>
	idempotencyKey: string
	source?: string | null
}) {
	const topic = normalizePackageSubscriptionTopic(input.topic)
	const idempotencyKey = input.idempotencyKey.trim()
	if (!idempotencyKey) {
		return buildJsonErrorResponse({
			status: 400,
			code: 'missing_idempotency_key',
			message:
				'Package subscription invocations require a non-empty idempotencyKey.',
		})
	}
	return await invokeSavedPackageModule({
		env: input.env,
		baseUrl: input.baseUrl,
		actor: {
			tokenId: internalEmailSubscriptionTokenId,
			userId: input.savedPackage.userId,
			email: '',
			displayName: `package:${input.savedPackage.kodyId}`,
		},
		savedPackage: input.savedPackage,
		invocationName: buildPackageSubscriptionArtifactName(topic),
		moduleSelector: {
			kind: 'subscription',
			topic,
		},
		params: input.params,
		idempotencyKey,
		source: normalizeNullableString(input.source) ?? 'email',
		topic,
		notFoundCode: 'subscription_not_found',
	})
}
