import { type ContentBlock } from '@modelcontextprotocol/sdk/types.js'
import { toHex } from '@kody-internal/shared/hex.ts'
import { extractRawContent, getExecutionErrorDetails } from '#mcp/executor.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { runBundledModuleWithRegistry } from '#mcp/run-codemode-registry.ts'
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
	normalizePackageWorkspacePath,
	resolvePackageExportPath,
} from '#worker/package-registry/manifest.ts'
import { typecheckPackageEntrypointsFromSourceFiles } from '#worker/repo/checks.ts'
import {
	loadPublishedBundleArtifactByIdentity,
	persistPublishedBundleArtifact,
} from '#worker/package-runtime/published-bundle-artifacts.ts'
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

const internalEmailSubscriptionTokenId = 'internal:email-subscriptions'

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
	invocationName: string
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

async function ensureModuleArtifact(input: {
	env: Env
	baseUrl: string
	savedPackage: SavedPackageRecord
	selector: PackageModuleSelector
	userId: string
}) {
	const packageManifest = await loadPackageManifestBySourceId({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.userId,
		sourceId: input.savedPackage.sourceId,
	})
	const resolution = resolvePackageModuleResolution({
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
	manifest: Awaited<
		ReturnType<typeof loadPackageSourceBySourceId>
	>['manifest']
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
}) {
	const requestHash = await createRequestHash({
		packageId: input.savedPackage.id,
		invocationName: input.invocationName,
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
			repoContext: repoSource ? createRepoContext(repoSource) : null,
		})
		const executionResult = await runBundledModuleWithRegistry(
			input.env,
			callerContext,
			{
				mainModule: artifact.mainModule,
				modules: artifact.modules,
			},
			input.params,
			{
				skipCapabilityRegistry: true,
				storageTools: {
					userId: input.actor.userId,
					storageId: buildPackageInvocationStorageId(input.savedPackage.id),
					writable: true,
				},
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
				...(artifact.packageContext
					? { packageContext: artifact.packageContext }
					: {}),
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

	return await invokeSavedPackageModule({
		env: input.env,
		baseUrl: input.baseUrl,
		actor: {
			tokenId: input.token.tokenId,
			userId: input.token.userId,
			email: input.token.email,
			displayName: input.token.displayName,
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
			message: 'Package subscription invocations require a non-empty idempotencyKey.',
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
