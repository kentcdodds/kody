import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { persistableExecutionArtifacts } from '#mcp/downstream-mcp-result.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { runBundledModuleWithRegistry } from '#mcp/run-kody-registry.ts'
import { withAccountWriteLease } from '#worker/account/deletion-state.ts'
import { type RunRecordContext } from '#worker/run-records/types.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import { getEntitySourceById } from '#worker/repo/entity-sources.ts'
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
	type PackageModuleSelector,
	type PackageRuntimeToolFactories,
} from './common.ts'
import { createRequestHash, resolveExistingInvocation } from './idempotency.ts'
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
import {
	getPackageInvocationByKey,
	insertPackageInvocationRow,
	releasePackageInvocationClaim,
	tryClaimStalePackageInvocation,
	updatePackageInvocationResult,
	type PackageInvocationStoredResponse,
} from './repo.ts'

export const packageInvocationStaleAfterMs = 15 * 60 * 1000
const packageInvocationPollIntervalMs = 100
const packageInvocationPollBudgetMs = 1_000

function isStaleInvocation(updatedAt: string, now: Date) {
	return Date.parse(updatedAt) <= now.getTime() - packageInvocationStaleAfterMs
}

export async function invokeSavedPackageModule(input: {
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
	toolFactories: PackageRuntimeToolFactories
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	return await withAccountWriteLease({
		db: input.env.APP_DB,
		stableUserId: input.actor.userId,
		async write() {
			const requestHash = await createRequestHash({
				packageId: input.savedPackage.id,
				exportName: input.invocationName,
				params: input.params,
				source: input.source,
				topic: input.topic,
			})
			const lookupInvocation = async () =>
				await getPackageInvocationByKey({
					db: input.env.APP_DB,
					userId: input.actor.userId,
					tokenId: input.actor.tokenId,
					packageId: input.savedPackage.id,
					exportName: input.invocationName,
					idempotencyKey: input.idempotencyKey,
				})
			let existing: Awaited<ReturnType<typeof getPackageInvocationByKey>>
			let executionStarted = false
			try {
				existing = await lookupInvocation()
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
			let invocationId: string = crypto.randomUUID()
			let claimUpdatedAt: string | null = null
			if (existing) {
				if (
					existing.request_hash !== requestHash ||
					existing.status !== 'in_progress'
				) {
					return resolveExistingInvocation({
						record: existing,
						requestHash,
						idempotencyKey: input.idempotencyKey,
					})
				}
				const pollDeadline = Date.now() + packageInvocationPollBudgetMs
				while (
					existing.status === 'in_progress' &&
					!isStaleInvocation(existing.updated_at, new Date()) &&
					Date.now() < pollDeadline
				) {
					await new Promise((resolve) =>
						setTimeout(resolve, packageInvocationPollIntervalMs),
					)
					existing = await lookupInvocation()
					if (!existing) break
				}
				if (!existing) {
					return buildJsonErrorResponse({
						status: 500,
						code: 'idempotency_conflict_unresolved',
						message: 'Package invocation disappeared while polling.',
						idempotencyKey: input.idempotencyKey,
					})
				}
				if (existing.status !== 'in_progress') {
					return resolveExistingInvocation({
						record: existing,
						requestHash,
						idempotencyKey: input.idempotencyKey,
					})
				}
				const now = new Date()
				if (!isStaleInvocation(existing.updated_at, now)) {
					return resolveExistingInvocation({
						record: existing,
						requestHash,
						idempotencyKey: input.idempotencyKey,
					})
				}
				const reclaimedAt = now.toISOString()
				const reclaimed = await tryClaimStalePackageInvocation({
					db: input.env.APP_DB,
					id: existing.id,
					userId: input.actor.userId,
					expectedUpdatedAt: existing.updated_at,
					staleBefore: new Date(
						now.getTime() - packageInvocationStaleAfterMs,
					).toISOString(),
					now: reclaimedAt,
				})
				if (!reclaimed) {
					const current = await lookupInvocation()
					if (!current) {
						return buildJsonErrorResponse({
							status: 500,
							code: 'idempotency_conflict_unresolved',
							message: 'Stale package invocation reclaim conflicted.',
							idempotencyKey: input.idempotencyKey,
						})
					}
					return resolveExistingInvocation({
						record: current,
						requestHash,
						idempotencyKey: input.idempotencyKey,
					})
				}
				invocationId = existing.id
				claimUpdatedAt = reclaimedAt
			}

			if (!claimUpdatedAt) {
				let insertResult: Awaited<ReturnType<typeof insertPackageInvocationRow>>
				try {
					insertResult = await insertPackageInvocationRow({
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
					console.error(
						'package invocation idempotency persistence failed',
						error,
					)
					return buildJsonErrorResponse({
						status: 500,
						code: 'idempotency_persistence_failed',
						message:
							'Unable to persist the package invocation idempotency record. Please retry.',
						idempotencyKey: input.idempotencyKey,
					})
				}
				if (insertResult.inserted) {
					claimUpdatedAt = insertResult.claimUpdatedAt
				} else {
					let current: Awaited<ReturnType<typeof getPackageInvocationByKey>>
					try {
						current = await lookupInvocation()
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
			}
			if (!claimUpdatedAt) {
				throw new Error(
					'Package invocation claim timestamp was not established.',
				)
			}
			const persistClaimedResult = async (
				status: 'completed' | 'failed',
				response: PackageInvocationStoredResponse,
			) => {
				const updated = await updatePackageInvocationResult({
					db: input.env.APP_DB,
					id: invocationId,
					userId: input.actor.userId,
					status,
					response,
					claimUpdatedAt,
				})
				if (updated) return response
				const current = await lookupInvocation()
				if (current) {
					return resolveExistingInvocation({
						record: current,
						requestHash,
						idempotencyKey: input.idempotencyKey,
					})
				}
				return buildJsonErrorResponse({
					status: 500,
					code: 'idempotency_response_unavailable',
					message: 'Package invocation result lost its recovery claim.',
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
								invocationId,
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
						packageInvokeTools:
							input.toolFactories.createPackageRuntimeInvokeTools({
								env: input.env,
								baseUrl: input.baseUrl,
								callerContext,
								packageContext,
								parentRunRecord: runRecord,
								packageInvokeDepth: input.runtimeInvokeDepth ?? 0,
								waitUntil: input.waitUntil,
							}),
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
				let response: PackageInvocationStoredResponse
				if (executionResult.error) {
					response = buildExecutionErrorResponse({
						savedPackage: input.savedPackage,
						invocationName: input.invocationName,
						idempotencyKey: input.idempotencyKey,
						source: input.source,
						topic: input.topic,
						error: executionResult.error,
						logs: executionResult.logs ?? [],
					})
				} else {
					const persistedArtifacts = persistableExecutionArtifacts(
						executionResult.result,
					)
					response = buildExecutionSuccessResponse({
						savedPackage: input.savedPackage,
						invocationName: input.invocationName,
						idempotencyKey: input.idempotencyKey,
						source: input.source,
						topic: input.topic,
						result: persistedArtifacts.result,
						rawContent: persistedArtifacts.rawContent,
						rawContentOmitted: persistedArtifacts.rawContentOmitted,
						logs: executionResult.logs ?? [],
					})
				}
				return await persistClaimedResult(
					executionResult.error ? 'failed' : 'completed',
					response,
				)
			} catch (error) {
				if (
					!executionStarted &&
					!isMissingPackageModuleError(error) &&
					isTransientModuleArtifactError(error)
				) {
					const released = await releasePackageInvocationClaim({
						db: input.env.APP_DB,
						id: invocationId,
						userId: input.actor.userId,
						claimUpdatedAt,
					})
					if (!released) {
						const current = await lookupInvocation()
						if (current?.status !== 'in_progress') {
							return current
								? resolveExistingInvocation({
										record: current,
										requestHash,
										idempotencyKey: input.idempotencyKey,
									})
								: buildJsonErrorResponse({
										status: 500,
										code: 'idempotency_conflict_unresolved',
										message:
											'Transient artifact preparation lost its invocation claim.',
										idempotencyKey: input.idempotencyKey,
									})
						}
					}
					return buildJsonErrorResponse({
						status: 503,
						code: 'artifact_preparation_failed',
						message:
							'Package artifact preparation failed before execution. Please retry.',
						idempotencyKey: input.idempotencyKey,
					})
				}
				if (isMissingPackageModuleError(error)) {
					const response = buildJsonErrorResponse({
						status: 404,
						code: input.notFoundCode,
						message: getErrorMessage(error),
						idempotencyKey: input.idempotencyKey,
					})
					return await persistClaimedResult('failed', response).catch(() => {
						// Best effort; preserve the original invocation error.
						return response
					})
				}
				const response = buildJsonErrorResponse({
					status: 500,
					code: 'invocation_failed',
					message: getErrorMessage(error),
					idempotencyKey: input.idempotencyKey,
				})
				return await persistClaimedResult('failed', response).catch(() => {
					// Best effort; preserve the original invocation error.
					return response
				})
			}
		},
	})
}
