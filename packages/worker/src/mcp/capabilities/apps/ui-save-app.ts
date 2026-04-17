import { z } from 'zod'
import { buildSavedUiUrl } from '#worker/ui-artifact-urls.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { errorFields, logMcpEvent } from '#mcp/observability.ts'
import {
	deleteUiArtifact,
	getUiArtifactById,
	insertUiArtifact,
	updateUiArtifact,
} from '#mcp/ui-artifacts-repo.ts'
import { buildUiArtifactEmbedText } from '#mcp/ui-artifacts-embed.ts'
import {
	deleteUiArtifactVector,
	upsertUiArtifactVector,
} from '#mcp/ui-artifacts-vectorize.ts'
import {
	configureSavedAppRunner,
	deleteSavedAppRunner,
} from '#mcp/app-runner.ts'
import { hasUiArtifactServerCode } from '#mcp/ui-artifacts-types.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import {
	normalizeUiArtifactParameters,
	parseUiArtifactParameters,
	uiArtifactParameterSchema,
} from '#mcp/ui-artifact-parameters.ts'
import { syncArtifactSourceSnapshot } from '#worker/repo/source-sync.ts'
import { buildAppSourceFiles } from '#worker/repo/source-templates.ts'
import {
	ensureEntitySource,
	getRepoSourceSupportStatus,
} from '#worker/repo/source-service.ts'
import {
	getEntitySourceById,
	updateEntitySource,
} from '#worker/repo/entity-sources.ts'

const appServerCodeExportPattern =
	/export\s+class\s+App\s+extends\s+DurableObject\b/

function assertValidSavedAppServerCode(serverCode: string | null | undefined) {
	if (serverCode == null) return
	if (!appServerCodeExportPattern.test(serverCode)) {
		throw new Error('serverCode must export class App extends DurableObject')
	}
}

function hasAppDbBinding(db: D1Database | null | undefined) {
	return typeof db?.prepare === 'function'
}

const inputSchema = z
	.object({
		app_id: z
			.string()
			.min(1)
			.optional()
			.describe(
				'Optional saved UI artifact id to update in place. Omit to create a new saved app. When app_id is provided, omitted fields preserve the existing saved value.',
			),
		title: z
			.string()
			.min(1)
			.optional()
			.describe(
				'Short title for the saved UI artifact. Required when creating a new saved app.',
			),
		description: z
			.string()
			.min(1)
			.optional()
			.describe('What the saved app does and when it is useful.'),
		clientCode: z
			.string()
			.min(1)
			.optional()
			.describe(
				'HTML source for the generic MCP UI shell. Provide a self-contained HTML document or fragment. If the app needs browser-side logic, include it with `<script type="module">...</script>` inside the HTML. For non-trivial saved apps, keep clientCode focused on UI and fetches to the saved app backend instead of embedding large server-side `executeCode(...)` strings. Required when creating a new saved app.',
			),
		serverCode: z
			.string()
			.min(1)
			.nullable()
			.optional()
			.describe(
				'Optional Durable Object server code for this saved app. The code must export `class App extends DurableObject` and can use its own isolated facet SQLite storage. Prefer serverCode for non-trivial or integration-backed saved apps. Omit this field on updates to preserve the current backend, or pass null to clear it explicitly.',
			),
		parameters: z
			.array(uiArtifactParameterSchema)
			.optional()
			.describe(
				'Optional parameter definitions for reusable saved apps. Resolved values are exposed at runtime on the imported `kodyWidget.params` helper from `@kody/ui-utils`.',
			),
		hidden: z
			.boolean()
			.optional()
			.describe(
				'Whether this saved app should stay hidden from search results. Defaults to true so one-off apps stay private unless explicitly made discoverable.',
			),
	})
	.superRefine((value, ctx) => {
		if (value.app_id !== undefined) {
			if (
				value.serverCode != null &&
				!appServerCodeExportPattern.test(value.serverCode)
			) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ['serverCode'],
					message: 'serverCode must export class App extends DurableObject',
				})
			}
			return
		}
		if (value.title === undefined) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['title'],
				message: 'title is required when creating a saved app.',
			})
		}
		if (value.description === undefined) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['description'],
				message: 'description is required when creating a saved app.',
			})
		}
		if (value.clientCode === undefined) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['clientCode'],
				message: 'clientCode is required when creating a saved app.',
			})
		}
		if (
			value.serverCode != null &&
			!appServerCodeExportPattern.test(value.serverCode)
		) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['serverCode'],
				message: 'serverCode must export class App extends DurableObject',
			})
		}
	})

const outputSchema = z.object({
	app_id: z.string(),
	server_code_id: z.string(),
	has_server_code: z.boolean(),
	hosted_url: z.string().url(),
	parameters: z.array(uiArtifactParameterSchema).nullable(),
	hidden: z.boolean(),
})

export const uiSaveAppCapability = defineDomainCapability(
	capabilityDomainNames.apps,
	{
		name: 'ui_save_app',
		description:
			'Create a saved UI artifact or partially update an existing one for the signed-in user so it can be reopened later by app_id without sending the source back through the model context. When updating, omitted fields preserve the existing saved value. For non-trivial or integration-backed saved apps, prefer `serverCode` backend endpoints with `clientCode` fetches through `kodyWidget.appBackend.basePath`; reserve embedded client-side `executeCode(...)` strings for quick prototypes or one-off experiments. If the saved app depends on a third-party integration, load `kody_official_guide` with `guide: "integration_bootstrap"` first and verify the required connector/secret plus a minimal authenticated smoke test before treating the downstream app as complete.',
		keywords: ['ui', 'app', 'artifact', 'save', 'persist', 'update', 'mcp app'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema,
		outputSchema,
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			const isUpdate = args.app_id !== undefined
			const appId = args.app_id ?? crypto.randomUUID()
			const repoSourceSupport = getRepoSourceSupportStatus({
				db: ctx.env.APP_DB,
				env: ctx.env,
			})
			const ensureSource = () =>
				repoSourceSupport.ok
					? ensureEntitySource({
							db: ctx.env.APP_DB,
							env: ctx.env,
							userId: user.userId,
							entityKind: 'app',
							entityId: appId,
							sourceRoot: '/',
						})
					: null
			let hidden: boolean
			let existingApp: Awaited<ReturnType<typeof getUiArtifactById>> | null =
				null

			const readPublishedCommit = async (
				sourceId: string,
			): Promise<string | null> => {
				if (!hasAppDbBinding(ctx.env.APP_DB)) {
					return null
				}
				return (
					(await getEntitySourceById(ctx.env.APP_DB, sourceId))
						?.published_commit ?? null
				)
			}

			const restorePublishedCommit = async (
				sourceId: string | null,
				publishedCommit: string | null,
			) => {
				if (!sourceId) {
					return
				}
				if (!hasAppDbBinding(ctx.env.APP_DB)) {
					return
				}
				await updateEntitySource(ctx.env.APP_DB, {
					id: sourceId,
					userId: user.userId,
					publishedCommit,
				})
			}

			async function saveAndIndexApp(input: {
				appId: string
				title: string
				description: string
				clientCode: string
				serverCode: string | null
				serverCodeId: string
				parameters: ReturnType<typeof normalizeUiArtifactParameters>
				hidden: boolean
				sourceId: string | null
				previousPublishedCommit: string | null
				existingApp: Awaited<ReturnType<typeof getUiArtifactById>> | null
			}) {
				const hasBackend = hasUiArtifactServerCode(input.serverCode)
				try {
					await configureSavedAppRunner({
						env: ctx.env,
						appId: input.appId,
						userId: user.userId,
						baseUrl: ctx.callerContext.baseUrl,
						serverCode: input.serverCode,
						serverCodeId: input.serverCodeId,
					})
				} catch (cause) {
					if (!isUpdate) {
						await Promise.allSettled([
							deleteSavedAppRunner({
								env: ctx.env,
								appId: input.appId,
							}),
							deleteUiArtifact(ctx.env.APP_DB, user.userId, input.appId),
							restorePublishedCommit(
								input.sourceId,
								input.previousPublishedCommit,
							),
						])
					} else if (input.existingApp) {
						try {
							await Promise.allSettled([
								updateUiArtifact(ctx.env.APP_DB, user.userId, input.appId, {
									title: input.existingApp.title,
									description: input.existingApp.description,
									sourceId: input.existingApp.sourceId,
									clientCode: input.existingApp.clientCode,
									serverCode: input.existingApp.serverCode,
									serverCodeId: input.existingApp.serverCodeId,
									parameters: input.existingApp.parameters,
									hidden: input.existingApp.hidden,
								}),
								restorePublishedCommit(
									input.sourceId,
									input.previousPublishedCommit,
								),
							])
						} catch {
							// Preserve the original runner configuration failure.
						}
					}
					throw cause
				}

				try {
					if (!input.hidden) {
						await upsertUiArtifactVector(ctx.env, {
							appId: input.appId,
							userId: user.userId,
							embedText: buildUiArtifactEmbedText({
								title: input.title,
								description: input.description,
								hasServerCode: hasBackend,
								parameters: input.parameters,
							}),
						})
					} else if (isUpdate) {
						await deleteUiArtifactVector(ctx.env, input.appId)
					}
				} catch (cause) {
					if (!isUpdate) {
						await Promise.allSettled([
							deleteSavedAppRunner({
								env: ctx.env,
								appId: input.appId,
							}),
							deleteUiArtifact(ctx.env.APP_DB, user.userId, input.appId),
							restorePublishedCommit(
								input.sourceId,
								input.previousPublishedCommit,
							),
						])
						throw cause
					}

					const { errorName, errorMessage } = errorFields(cause)
					logMcpEvent({
						category: 'mcp',
						tool: 'capability',
						capabilityName: 'ui_save_app',
						domain: capabilityDomainNames.apps,
						outcome: 'failure',
						durationMs: 0,
						baseUrl: ctx.callerContext.baseUrl,
						hasUser: true,
						failurePhase: 'handler',
						message:
							'Failed to refresh saved app vector index after in-place update.',
						errorName,
						errorMessage,
						cause,
						context: {
							userId: user.userId,
							appId: input.appId,
							isUpdate,
						},
					})
				}

				return {
					app_id: input.appId,
					server_code_id: input.serverCodeId,
					has_server_code: hasBackend,
					hosted_url: buildSavedUiUrl(ctx.callerContext.baseUrl, input.appId),
					parameters: input.parameters,
					hidden: input.hidden,
				}
			}

			if (isUpdate) {
				existingApp = await getUiArtifactById(
					ctx.env.APP_DB,
					user.userId,
					appId,
				)
				if (!existingApp) {
					throw new Error('Saved UI artifact not found for this user.')
				}
				if (existingApp.sourceId != null && !repoSourceSupport.ok) {
					throw new Error(repoSourceSupport.reason)
				}
				const ensuredSource = await ensureSource()
				const title = args.title ?? existingApp.title
				const description = args.description ?? existingApp.description
				const clientCode = args.clientCode ?? existingApp.clientCode
				const serverCode =
					args.serverCode === undefined
						? existingApp.serverCode
						: args.serverCode
				assertValidSavedAppServerCode(serverCode)
				const parameters =
					args.parameters === undefined
						? parseUiArtifactParameters(existingApp.parameters)
						: normalizeUiArtifactParameters(args.parameters)
				const serializedParameters =
					args.parameters === undefined
						? undefined
						: parameters
							? JSON.stringify(parameters)
							: null
				const serverCodeChanged = serverCode !== existingApp.serverCode
				const serverCodeId = serverCodeChanged
					? crypto.randomUUID()
					: existingApp.serverCodeId
				const updates: Parameters<typeof updateUiArtifact>[3] = {
					title: args.title,
					description: args.description,
					clientCode: args.clientCode,
					hidden: args.hidden,
				}
				if (ensuredSource) {
					updates.sourceId = ensuredSource.id
				}
				if (args.parameters !== undefined) {
					updates.parameters = serializedParameters
				}
				if (args.serverCode !== undefined) {
					updates.serverCode = serverCode
					updates.serverCodeId = serverCodeId
				}
				const updated = await updateUiArtifact(
					ctx.env.APP_DB,
					user.userId,
					appId,
					updates,
				)
				if (!updated) {
					throw new Error('Saved UI artifact not found for this user.')
				}
				const previousPublishedCommit = ensuredSource
					? await readPublishedCommit(ensuredSource.id)
					: null
				try {
					if (ensuredSource) {
						const publishedCommit = await syncArtifactSourceSnapshot({
							env: ctx.env,
							userId: user.userId,
							baseUrl: ctx.callerContext.baseUrl,
							sourceId: ensuredSource.id,
							files: buildAppSourceFiles({
								title,
								description,
								parameters,
								hidden: args.hidden ?? existingApp.hidden,
								clientCode,
								serverCode,
							}),
						})
						if (publishedCommit == null) {
							throw new Error(
								'Saved app source sync did not publish a repo-backed commit.',
							)
						}
						await updateEntitySource(ctx.env.APP_DB, {
							id: ensuredSource.id,
							userId: user.userId,
							publishedCommit,
							indexedCommit: publishedCommit,
						})
					}
				} catch (cause) {
					await Promise.allSettled([
						updateUiArtifact(ctx.env.APP_DB, user.userId, appId, {
							title: existingApp.title,
							description: existingApp.description,
							sourceId: existingApp.sourceId,
							clientCode: existingApp.clientCode,
							serverCode: existingApp.serverCode,
							serverCodeId: existingApp.serverCodeId,
							parameters: existingApp.parameters,
							hidden: existingApp.hidden,
						}),
						restorePublishedCommit(
							ensuredSource?.id ?? null,
							previousPublishedCommit,
						),
					])
					throw cause
				}
				hidden = args.hidden ?? existingApp.hidden
				return await saveAndIndexApp({
					appId,
					title,
					description,
					clientCode,
					serverCode,
					serverCodeId,
					parameters,
					hidden,
					sourceId: ensuredSource?.id ?? existingApp.sourceId,
					previousPublishedCommit,
					existingApp,
				})
			} else {
				const title = args.title!
				const description = args.description!
				const clientCode = args.clientCode!
				const serverCode = args.serverCode ?? null
				assertValidSavedAppServerCode(serverCode)
				const parameters = normalizeUiArtifactParameters(args.parameters)
				const serializedParameters = parameters
					? JSON.stringify(parameters)
					: null
				const serverCodeId = crypto.randomUUID()
				hidden = args.hidden ?? true
				const ensuredSource = await ensureSource()
				const now = new Date().toISOString()
				await insertUiArtifact(ctx.env.APP_DB, {
					id: appId,
					user_id: user.userId,
					sourceId: ensuredSource?.id ?? null,
					title,
					description,
					clientCode,
					serverCode,
					serverCodeId,
					parameters: serializedParameters,
					hidden,
					created_at: now,
					updated_at: now,
				})
				const previousPublishedCommit = ensuredSource
					? await readPublishedCommit(ensuredSource.id)
					: null
				try {
					if (ensuredSource) {
						const publishedCommit = await syncArtifactSourceSnapshot({
							env: ctx.env,
							userId: user.userId,
							baseUrl: ctx.callerContext.baseUrl,
							sourceId: ensuredSource.id,
							files: buildAppSourceFiles({
								title,
								description,
								parameters,
								hidden,
								clientCode,
								serverCode,
							}),
						})
						if (publishedCommit == null) {
							throw new Error(
								'Saved app source sync did not publish a repo-backed commit.',
							)
						}
						await updateEntitySource(ctx.env.APP_DB, {
							id: ensuredSource.id,
							userId: user.userId,
							publishedCommit,
							indexedCommit: publishedCommit,
						})
					}
				} catch (cause) {
					await Promise.allSettled([
						deleteUiArtifact(ctx.env.APP_DB, user.userId, appId),
						restorePublishedCommit(
							ensuredSource?.id ?? null,
							previousPublishedCommit,
						),
					])
					throw cause
				}
				return await saveAndIndexApp({
					appId,
					title,
					description,
					clientCode,
					serverCode,
					serverCodeId,
					parameters,
					hidden,
					sourceId: ensuredSource?.id ?? null,
					previousPublishedCommit,
					existingApp,
				})
			}
		},
	},
)
