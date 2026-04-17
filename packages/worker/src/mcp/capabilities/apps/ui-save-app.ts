import { z } from 'zod'
import { buildSavedUiUrl } from '#worker/ui-artifact-urls.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
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
import { hasSavedAppBackend, resolveSavedAppSource } from '#worker/repo/app-source.ts'
import {
	getEntitySourceById,
	updateEntitySource,
} from '#worker/repo/entity-sources.ts'

const appServerCodeExportPattern =
	/export\s+class\s+App\s+extends\s+DurableObject\b/

type SavedAppDraft = {
	title: string
	description: string
	clientCode: string
	serverCode: string | null
	serverCodeId: string
	parameters: ReturnType<typeof normalizeUiArtifactParameters>
	hidden: boolean
}

function assertValidSavedAppServerCode(serverCode: string | null | undefined) {
	if (serverCode == null) return
	if (!appServerCodeExportPattern.test(serverCode)) {
		throw new Error('serverCode must export class App extends DurableObject')
	}
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
			if (!repoSourceSupport.ok) {
				throw new Error(repoSourceSupport.reason)
			}
			const ensureSource = () =>
				ensureEntitySource({
					db: ctx.env.APP_DB,
					env: ctx.env,
					userId: user.userId,
					entityKind: 'app',
					entityId: appId,
					sourceRoot: '/',
				})
			let hidden: boolean
			let existingApp: Awaited<ReturnType<typeof getUiArtifactById>> | null =
				null

			const readPublishedCommit = async (sourceId: string): Promise<string | null> =>
				(await getEntitySourceById(ctx.env.APP_DB, sourceId))?.published_commit ??
				null

			const restorePublishedCommit = async (
				sourceId: string,
				publishedCommit: string | null,
			) => {
				await updateEntitySource(ctx.env.APP_DB, {
					id: sourceId,
					userId: user.userId,
					publishedCommit,
				})
			}

			async function saveMetadataProjection(input: {
				appId: string
				title: string
				description: string
				parameters: ReturnType<typeof normalizeUiArtifactParameters>
				hidden: boolean
				sourceId: string
				serverCode: string | null
				existingApp: Awaited<ReturnType<typeof getUiArtifactById>> | null
			}) {
				const hasBackend = hasSavedAppBackend({
					serverCode: input.serverCode,
				})
				const serializedParameters = input.parameters
					? JSON.stringify(input.parameters)
					: null
				const updated = input.existingApp
					? await updateUiArtifact(ctx.env.APP_DB, user.userId, input.appId, {
							title: input.title,
							description: input.description,
							sourceId: input.sourceId,
							parameters: serializedParameters,
							hidden: input.hidden,
						})
					: await insertUiArtifact(ctx.env.APP_DB, {
							id: input.appId,
							user_id: user.userId,
							title: input.title,
							description: input.description,
							sourceId: input.sourceId,
							parameters: serializedParameters,
							hidden: input.hidden,
							created_at: new Date().toISOString(),
							updated_at: new Date().toISOString(),
						})
				if (input.existingApp && !updated) {
					throw new Error('Saved UI artifact not found for this user.')
				}
				try {
					const resolvedSource = await getEntitySourceById(
						ctx.env.APP_DB,
						input.sourceId,
					)
					const serverCodeId =
						resolvedSource?.published_commit ??
						crypto.randomUUID()
					await configureSavedAppRunner({
						env: ctx.env,
						appId: input.appId,
						userId: user.userId,
						baseUrl: ctx.callerContext.baseUrl,
						serverCode: null,
						serverCodeId,
					})
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
					return {
						app_id: input.appId,
						server_code_id: serverCodeId,
						has_server_code: hasBackend,
						hosted_url: buildSavedUiUrl(ctx.callerContext.baseUrl, input.appId),
						parameters: input.parameters,
						hidden: input.hidden,
					}
				} catch (cause) {
					if (!input.existingApp) {
						await Promise.allSettled([
							deleteSavedAppRunner({
								env: ctx.env,
								appId: input.appId,
							}),
							deleteUiArtifact(ctx.env.APP_DB, user.userId, input.appId),
						])
					}
					throw cause
				}
			}

			const persistRepoSource = async (input: {
				sourceId: string
				draft: SavedAppDraft
			}) => {
				const previousPublishedCommit = await readPublishedCommit(input.sourceId)
				try {
					const publishedCommit = await syncArtifactSourceSnapshot({
						env: ctx.env,
						userId: user.userId,
						baseUrl: ctx.callerContext.baseUrl,
						sourceId: input.sourceId,
						files: buildAppSourceFiles({
							title: input.draft.title,
							description: input.draft.description,
							parameters: input.draft.parameters,
							hidden: input.draft.hidden,
							clientCode: input.draft.clientCode,
							serverCode: input.draft.serverCode,
						}),
					})
					if (publishedCommit == null) {
						throw new Error(
							'Saved app source sync did not publish a repo-backed commit.',
						)
					}
					await updateEntitySource(ctx.env.APP_DB, {
						id: input.sourceId,
						userId: user.userId,
						publishedCommit,
						indexedCommit: publishedCommit,
					})
				} catch (cause) {
					await restorePublishedCommit(input.sourceId, previousPublishedCommit)
					throw cause
				}
			}

				const buildDraft = (
					current: Awaited<ReturnType<typeof getUiArtifactById>> | null,
				): SavedAppDraft => {
				const title = args.title ?? current?.title
				const description = args.description ?? current?.description
				if (!title || !description) {
					throw new Error('Saved apps require title and description.')
				}
				const clientCode =
					args.clientCode ??
					(current
						? (() => {
								throw new Error(
									'Existing saved apps must be reopened from repo-backed source before updating.',
								)
							})()
						: undefined)
				if (!clientCode) {
					throw new Error('clientCode is required when creating a saved app.')
				}
				const serverCode =
					args.serverCode === undefined
						? null
						: args.serverCode
				assertValidSavedAppServerCode(serverCode)
				return {
					title,
					description,
					clientCode,
					serverCode,
					serverCodeId: crypto.randomUUID(),
					parameters:
						args.parameters === undefined
							? current
								? parseUiArtifactParameters(current.parameters)
								: null
							: normalizeUiArtifactParameters(args.parameters),
					hidden: args.hidden ?? current?.hidden ?? true,
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
				if (existingApp.sourceId == null) {
					throw new Error('Saved app is missing its repo-backed source reference.')
				}
				const ensuredSource = await ensureSource()
				if (existingApp.sourceId !== ensuredSource.id) {
					throw new Error('Saved app source reference does not match the entity source.')
				}
				const resolvedCurrent = await getEntitySourceById(
					ctx.env.APP_DB,
					existingApp.sourceId,
				)
				if (!resolvedCurrent?.published_commit) {
					throw new Error('Saved app does not have a published repo-backed source.')
				}
				const draft: SavedAppDraft = {
					title: args.title ?? existingApp.title,
					description: args.description ?? existingApp.description,
					clientCode:
						args.clientCode ??
						(await resolveSavedAppSource({
							env: ctx.env,
							baseUrl: ctx.callerContext.baseUrl,
							artifact: existingApp,
						})).clientCode,
					serverCode:
						args.serverCode === undefined
							? (
									await resolveSavedAppSource({
										env: ctx.env,
										baseUrl: ctx.callerContext.baseUrl,
										artifact: existingApp,
									})
								).serverCode
							: args.serverCode,
					serverCodeId: crypto.randomUUID(),
					parameters:
						args.parameters === undefined
							? parseUiArtifactParameters(existingApp.parameters)
							: normalizeUiArtifactParameters(args.parameters),
					hidden: args.hidden ?? existingApp.hidden,
				}
				assertValidSavedAppServerCode(draft.serverCode)
				await persistRepoSource({
					sourceId: ensuredSource.id,
					draft,
				})
				hidden = draft.hidden
				return await saveMetadataProjection({
					appId,
					title: draft.title,
					description: draft.description,
					parameters: draft.parameters,
					hidden,
					sourceId: ensuredSource.id,
					serverCode: draft.serverCode,
					existingApp,
				})
			}

			const draft = buildDraft(null)
			const ensuredSource = await ensureSource()
			await persistRepoSource({
				sourceId: ensuredSource.id,
				draft,
			})
			return await saveMetadataProjection({
				appId,
				title: draft.title,
				description: draft.description,
				parameters: draft.parameters,
				hidden: draft.hidden,
				sourceId: ensuredSource.id,
				serverCode: draft.serverCode,
				existingApp,
			})
		},
	},
)
