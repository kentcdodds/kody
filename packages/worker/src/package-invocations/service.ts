import { type ContentBlock } from '@modelcontextprotocol/sdk/types.js'
import { toHex } from '@kody-internal/shared/hex.ts'
import { extractRawContent, getExecutionErrorDetails } from '#mcp/executor.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { runBundledModuleWithRegistry } from '#mcp/run-codemode-registry.ts'
import {
	getSavedPackageById,
	getSavedPackageByKodyId,
} from '#worker/package-registry/repo.ts'
import { loadPackageSourceBySourceId } from '#worker/package-registry/source.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import { resolvePackageExportPath } from '#worker/package-registry/manifest.ts'
import { typecheckPackageEntrypointsFromSourceFiles } from '#worker/repo/checks.ts'
import {
	loadPublishedBundleArtifactByIdentity,
	persistPublishedBundleArtifact,
} from '#worker/package-runtime/published-bundle-artifacts.ts'
import { getEntitySourceById } from '#worker/repo/entity-sources.ts'
import { type EntitySourceRow } from '#worker/repo/types.ts'
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

function isMissingPackageExportError(error: unknown) {
	return (
		error instanceof Error &&
		(error.message.includes('does not define export') ||
			error.message.includes('does not define a runtime target'))
	)
}

async function ensureModuleArtifact(input: {
	env: Env
	baseUrl: string
	savedPackage: SavedPackageRecord
	exportName: string
	userId: string
}) {
	const packageSource = await loadPackageSourceBySourceId({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.userId,
		sourceId: input.savedPackage.sourceId,
	})
	const entryPoint = resolvePackageExportPath({
		manifest: packageSource.manifest,
		exportName: input.exportName,
	})
	const loaded = await loadPublishedBundleArtifactByIdentity({
		env: input.env,
		userId: input.userId,
		sourceId: input.savedPackage.sourceId,
		kind: 'module',
		artifactName: input.exportName,
		entryPoint,
	})
	if (loaded?.artifact) {
		return {
			artifact: loaded.artifact,
			source: packageSource.source,
			entryPoint,
		}
	}
	const typecheckResult = await typecheckPackageEntrypointsFromSourceFiles({
		sourceFiles: packageSource.files,
		entryPoints: [{ path: entryPoint, includeStorage: true }],
	})
	if (!typecheckResult.ok) {
		throw new Error(typecheckResult.message)
	}
	const { buildKodyModuleBundle } =
		await import('#worker/package-runtime/module-graph.ts')
	const bundle = await buildKodyModuleBundle({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.userId,
		sourceFiles: packageSource.files,
		entryPoint,
	})
	await persistPublishedBundleArtifact({
		env: input.env,
		userId: input.userId,
		source: packageSource.source,
		kind: 'module',
		artifactName: input.exportName,
		entryPoint,
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
		artifactName: input.exportName,
		entryPoint,
	})
	if (!rebuilt?.artifact) {
		throw new Error(
			`Published bundle artifact for export "${input.exportName}" could not be loaded after rebuild.`,
		)
	}
	return {
		artifact: rebuilt.artifact,
		source: packageSource.source,
		entryPoint,
	}
}

function buildExecutionSuccessResponse(input: {
	savedPackage: SavedPackageRecord
	exportName: string
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
			exportName: input.exportName,
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
	exportName: string
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
			exportName: input.exportName,
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

export async function invokePackageExport(input: {
	env: Env
	baseUrl: string
	token: PackageInvocationTokenScope
	request: PackageInvocationRequest
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

	const requestHash = await createRequestHash({
		packageId: savedPackage.id,
		exportName,
		params: input.request.params,
		source,
		topic,
	})
	let existing: Awaited<ReturnType<typeof getPackageInvocationByKey>>
	try {
		existing = await getPackageInvocationByKey({
			db: input.env.APP_DB,
			userId: input.token.userId,
			tokenId: input.token.tokenId,
			packageId: savedPackage.id,
			exportName,
			idempotencyKey,
		})
	} catch (error) {
		console.error('package invocation idempotency lookup failed', error)
		return buildJsonErrorResponse({
			status: 500,
			code: 'idempotency_lookup_failed',
			message:
				'Unable to look up the package invocation idempotency record. Please retry.',
			idempotencyKey,
		})
	}
	if (existing) {
		return resolveExistingInvocation({
			record: existing,
			requestHash,
			idempotencyKey,
		})
	}

	const invocationId = crypto.randomUUID()
	let inserted: boolean
	try {
		inserted = await insertPackageInvocationRow({
			db: input.env.APP_DB,
			row: {
				id: invocationId,
				userId: input.token.userId,
				tokenId: input.token.tokenId,
				packageId: savedPackage.id,
				packageKodyId: savedPackage.kodyId,
				exportName,
				idempotencyKey,
				requestHash,
				source,
				topic,
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
			idempotencyKey,
		})
	}
	if (!inserted) {
		let current: Awaited<ReturnType<typeof getPackageInvocationByKey>>
		try {
			current = await getPackageInvocationByKey({
				db: input.env.APP_DB,
				userId: input.token.userId,
				tokenId: input.token.tokenId,
				packageId: savedPackage.id,
				exportName,
				idempotencyKey,
			})
		} catch (error) {
			console.error('package invocation idempotency lookup failed', error)
			return buildJsonErrorResponse({
				status: 500,
				code: 'idempotency_lookup_failed',
				message:
					'Unable to look up the package invocation idempotency record. Please retry.',
				idempotencyKey,
			})
		}
		if (!current) {
			return buildJsonErrorResponse({
				status: 500,
				code: 'idempotency_conflict_unresolved',
				message:
					'Package invocation idempotency insert conflicted but no existing row was found.',
				idempotencyKey,
			})
		}
		return resolveExistingInvocation({
			record: current,
			requestHash,
			idempotencyKey,
		})
	}

	try {
		const { artifact, source: sourceRow } = await ensureModuleArtifact({
			env: input.env,
			baseUrl: input.baseUrl,
			savedPackage,
			exportName,
			userId: input.token.userId,
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
				userId: input.token.userId,
				email: input.token.email,
				displayName: input.token.displayName,
			},
			storageContext: {
				sessionId: null,
				appId: savedPackage.id,
				storageId: buildPackageInvocationStorageId(savedPackage.id),
			},
			repoContext: repoSource ? createRepoContext(repoSource) : null,
		})
		const executionResult = await runBundledModuleWithRegistry(
			input.env,
			callerContext,
			{
				mainModule: artifact.mainModule,
				modules: artifact.modules,
			},
			input.request.params,
			{
				storageTools: {
					userId: input.token.userId,
					storageId: buildPackageInvocationStorageId(savedPackage.id),
					writable: true,
				},
				...(artifact.packageContext
					? { packageContext: artifact.packageContext }
					: {}),
			},
		)
		const response = executionResult.error
			? buildExecutionErrorResponse({
					savedPackage,
					exportName,
					idempotencyKey,
					source,
					topic,
					error: executionResult.error,
					logs: executionResult.logs ?? [],
				})
			: buildExecutionSuccessResponse({
					savedPackage,
					exportName,
					idempotencyKey,
					source,
					topic,
					result: executionResult.result,
					logs: executionResult.logs ?? [],
					rawContent: extractRawContent(executionResult.result),
				})
		await updatePackageInvocationResult({
			db: input.env.APP_DB,
			id: invocationId,
			userId: input.token.userId,
			status: executionResult.error ? 'failed' : 'completed',
			response,
		})
		return response
	} catch (error) {
		if (isMissingPackageExportError(error)) {
			const response = buildJsonErrorResponse({
				status: 404,
				code: 'export_not_found',
				message: error instanceof Error ? error.message : String(error),
				idempotencyKey,
			})
			await updatePackageInvocationResult({
				db: input.env.APP_DB,
				id: invocationId,
				userId: input.token.userId,
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
			idempotencyKey,
		})
		await updatePackageInvocationResult({
			db: input.env.APP_DB,
			id: invocationId,
			userId: input.token.userId,
			status: 'failed',
			response,
		}).catch(() => {
			// Best effort; preserve the original invocation error.
		})
		return response
	}
}
