import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { persistableExecutionArtifacts } from '#mcp/downstream-mcp-result.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { runBundledModuleWithRegistry } from '#mcp/run-kody-registry.ts'
import { type RunRecordContext } from '#worker/run-records/types.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import { getEntitySourceByIdForUser } from '#worker/repo/entity-sources.ts'
import {
	getEmailAttachmentById,
	getEmailMessageById,
	getEmailMessageWithAttachmentsById,
} from '#worker/email/service.ts'
import {
	buildPackageInvocationStorageId,
	createRepoContext,
	resolveInvocationRuntimeName,
	resolveInvocationRuntimeSurface,
	type PackageInvocationActor,
	type PackageInvocationResponse,
	type PackageModuleSelector,
	type PackageRuntimeToolFactories,
} from './common.ts'
import {
	ensureModuleArtifact,
	isMissingPackageModuleError,
	isTransientModuleArtifactError,
} from './module-artifacts.ts'
import {
	buildExecutionErrorResponse,
	buildExecutionSuccessResponse,
	buildJsonErrorResponse,
} from './responses.ts'

/**
 * One saved-package module execution, uncoupled from durability:
 *
 * - `completed`: the sandbox ran and the export succeeded.
 * - `failed`: the sandbox ran and errored, the module/export was missing, or
 *   an unexpected error interrupted the run. Keyed callers persist this as a
 *   terminal ledger state.
 * - `artifact-unavailable`: artifact preparation failed transiently before
 *   any sandbox work started. Nothing executed, so keyed callers release
 *   their claim and key-less callers can simply retry.
 */
export type SavedPackageModuleRunOutcome =
	| { kind: 'completed'; response: PackageInvocationResponse }
	| { kind: 'failed'; response: PackageInvocationResponse }
	| { kind: 'artifact-unavailable'; response: PackageInvocationResponse }

export type SavedPackageModuleRunInput = {
	env: Env
	baseUrl: string
	actor: PackageInvocationActor
	savedPackage: SavedPackageRecord
	invocationName: string
	moduleSelector: PackageModuleSelector
	params?: Record<string, unknown>
	/**
	 * `null` for key-less (ephemeral) invocations: no ledger row exists, the
	 * response carries no `idempotency` section, and the run record downgrades
	 * to on-failure-only persistence (see `runPersistenceForContext`).
	 */
	idempotencyKey: string | null
	/** Ledger row id for keyed invocations; `null` for key-less ones. */
	invocationId: string | null
	source: string | null
	topic: string | null
	notFoundCode: 'export_not_found' | 'subscription_not_found'
	runtimeInvokeDepth?: number
	toolFactories: PackageRuntimeToolFactories
	waitUntil?: (promise: Promise<unknown>) => void
	/**
	 * Artifact already prepared by a `packages.invoke` check phase moments
	 * earlier; skips a second manifest + artifact load.
	 */
	preloadedModuleArtifact?: Awaited<
		ReturnType<typeof ensureModuleArtifact>
	> | null
}

export async function runSavedPackageModuleOnce(
	input: SavedPackageModuleRunInput,
): Promise<SavedPackageModuleRunOutcome> {
	let executionStarted = false
	try {
		const { artifact, source: sourceRow } =
			input.preloadedModuleArtifact ??
			(await ensureModuleArtifact({
				env: input.env,
				baseUrl: input.baseUrl,
				savedPackage: input.savedPackage,
				selector: input.moduleSelector,
				userId: input.actor.userId,
			}))
		const repoSource =
			artifact.packageContext?.sourceId == null ||
			artifact.packageContext.sourceId === sourceRow.id
				? sourceRow
				: await getEntitySourceByIdForUser(input.env.APP_DB, {
						id: artifact.packageContext.sourceId,
						userId: input.actor.userId,
					})
		const callerContext = createMcpCallerContext({
			baseUrl: input.baseUrl,
			executionOrigin: 'background',
			user: {
				userId: input.actor.userId,
				email: input.actor.email,
				username: undefined,
				displayName: input.actor.displayName,
			},
			storageContext: {
				sessionId: null,
				appId: input.savedPackage.id,
				packageId: input.savedPackage.id,
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
		const runRecord: RunRecordContext | null =
			runtimeSurface == null
				? null
				: {
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
						invocationId: input.invocationId,
						idempotencyKey: input.idempotencyKey,
						metadata: {
							exportName: input.invocationName,
							source: input.source,
							topic: input.topic,
						},
					}
		executionStarted = true
		const executionResult = await runBundledModuleWithRegistry(
			input.env,
			callerContext,
			{
				mainModule: artifact.mainModule,
				modules: artifact.modules,
				dependencies: artifact.dependencies,
			},
			input.params,
			{
				// No ambient `storage` binding: package code reaches its bucket via
				// `packageStorage()` (granted through packageContext below). Legacy
				// ambient use gets the structured runtime_helper_unbound hint.
				runRecord,
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
							delivery_status: loaded.message.deliveryStatus,
							delivery_status_at: loaded.message.deliveryStatusAt,
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
							blobs: input.env.EMAIL_BLOBS,
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
				packageInvokeTools: input.toolFactories.createPackageRuntimeInvokeTools(
					{
						env: input.env,
						baseUrl: input.baseUrl,
						callerContext,
						packageContext,
						parentRunRecord: runRecord,
						packageInvokeDepth: input.runtimeInvokeDepth ?? 0,
						waitUntil: input.waitUntil,
					},
				),
				packageEventTools: input.toolFactories.createPackageEventTools({
					env: input.env,
					baseUrl: input.baseUrl,
					callerContext,
					packageContext,
					parentRunRecord: runRecord,
					packageInvokeDepth: input.runtimeInvokeDepth ?? 0,
					waitUntil: input.waitUntil,
				}),
				waitUntil: input.waitUntil,
			},
		)
		if (executionResult.error) {
			return {
				kind: 'failed',
				response: buildExecutionErrorResponse({
					savedPackage: input.savedPackage,
					invocationName: input.invocationName,
					idempotencyKey: input.idempotencyKey,
					source: input.source,
					topic: input.topic,
					error: executionResult.error,
					logs: executionResult.logs ?? [],
				}),
			}
		}
		const persistedArtifacts = persistableExecutionArtifacts(
			executionResult.result,
		)
		return {
			kind: 'completed',
			response: buildExecutionSuccessResponse({
				savedPackage: input.savedPackage,
				invocationName: input.invocationName,
				idempotencyKey: input.idempotencyKey,
				source: input.source,
				topic: input.topic,
				result: persistedArtifacts.result,
				rawContent: persistedArtifacts.rawContent,
				rawContentOmitted: persistedArtifacts.rawContentOmitted,
				logs: executionResult.logs ?? [],
			}),
		}
	} catch (error) {
		if (
			!executionStarted &&
			!isMissingPackageModuleError(error) &&
			isTransientModuleArtifactError(error)
		) {
			return {
				kind: 'artifact-unavailable',
				response: buildJsonErrorResponse({
					status: 503,
					code: 'artifact_preparation_failed',
					message:
						'Package artifact preparation failed before execution. Please retry.',
					idempotencyKey: input.idempotencyKey ?? undefined,
				}),
			}
		}
		if (isMissingPackageModuleError(error)) {
			return {
				kind: 'failed',
				response: buildJsonErrorResponse({
					status: 404,
					code: input.notFoundCode,
					message: getErrorMessage(error),
					idempotencyKey: input.idempotencyKey ?? undefined,
				}),
			}
		}
		return {
			kind: 'failed',
			response: buildJsonErrorResponse({
				status: 500,
				code: 'invocation_failed',
				message: getErrorMessage(error),
				idempotencyKey: input.idempotencyKey ?? undefined,
			}),
		}
	}
}

/**
 * Key-less (lean) invocation path: contract-checked upstream, executed in the
 * target package's own runtime, with no idempotency ledger row, no account
 * write lease, and run records persisted on failure only. This is the
 * ephemeral counterpart to `invokeSavedPackageModule` (the keyed,
 * exactly-once path).
 */
export async function runSavedPackageModuleEphemeral(
	input: Omit<SavedPackageModuleRunInput, 'idempotencyKey' | 'invocationId'>,
): Promise<PackageInvocationResponse> {
	const outcome = await runSavedPackageModuleOnce({
		...input,
		idempotencyKey: null,
		invocationId: null,
	})
	return outcome.response
}
