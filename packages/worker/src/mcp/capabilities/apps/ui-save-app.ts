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
import { configureSavedAppRunner } from '#mcp/app-runner.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import {
	normalizeUiArtifactParameters,
	uiArtifactParameterSchema,
} from '#mcp/ui-artifact-parameters.ts'

const inputSchema = z.object({
	app_id: z
		.string()
		.min(1)
		.optional()
		.describe(
			'Optional saved UI artifact id to update in place. Omit to create a new saved app.',
		),
	title: z.string().min(1).describe('Short title for the saved UI artifact.'),
	description: z
		.string()
		.min(1)
		.describe('What the saved app does and when it is useful.'),
	clientCode: z
		.string()
		.min(1)
		.describe(
			'Client source for the generic MCP UI shell. Prefer a self-contained HTML document or fragment so the saved app owns the visible UI.',
		),
	serverCode: z
		.string()
		.min(1)
		.optional()
		.describe(
			'Optional Durable Object server code for this saved app. The code must export `class App extends DurableObject` and can use its own isolated facet SQLite storage.',
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
			'Create or replace a saved UI artifact for the signed-in user so it can be reopened later by app_id without sending the source back through the model context. If the saved app depends on a third-party integration, load `kody_official_guide` with `guide: "integration_bootstrap"` first and verify the required connector/secret plus a minimal authenticated smoke test before treating the downstream app as complete.',
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
			const serverCodeId = crypto.randomUUID()
			const parameters = normalizeUiArtifactParameters(args.parameters)
			const serializedParameters = parameters
				? JSON.stringify(parameters)
				: null
			let hidden: boolean
			let existingApp: Awaited<ReturnType<typeof getUiArtifactById>> | null =
				null

			if (isUpdate) {
				existingApp = await getUiArtifactById(
					ctx.env.APP_DB,
					user.userId,
					appId,
				)
				if (!existingApp) {
					throw new Error('Saved UI artifact not found for this user.')
				}
				const updated = await updateUiArtifact(
					ctx.env.APP_DB,
					user.userId,
					appId,
					{
						title: args.title,
						description: args.description,
						clientCode: args.clientCode,
						serverCode: args.serverCode ?? null,
						serverCodeId,
						parameters: serializedParameters,
						hidden: args.hidden,
					},
				)
				if (!updated) {
					throw new Error('Saved UI artifact not found for this user.')
				}
				hidden = args.hidden ?? existingApp.hidden
			} else {
				hidden = args.hidden ?? true
				const now = new Date().toISOString()
				await insertUiArtifact(ctx.env.APP_DB, {
					id: appId,
					user_id: user.userId,
					title: args.title,
					description: args.description,
					clientCode: args.clientCode,
					serverCode: args.serverCode ?? null,
					serverCodeId,
					parameters: serializedParameters,
					hidden,
					created_at: now,
					updated_at: now,
				})
			}

			try {
				await configureSavedAppRunner({
					env: ctx.env,
					appId,
					userId: user.userId,
					baseUrl: ctx.callerContext.baseUrl,
					serverCode: args.serverCode ?? null,
					serverCodeId,
				})
			} catch (cause) {
				if (!isUpdate) {
					await deleteUiArtifact(ctx.env.APP_DB, user.userId, appId)
				} else if (existingApp) {
					try {
						await updateUiArtifact(ctx.env.APP_DB, user.userId, appId, {
							title: existingApp.title,
							description: existingApp.description,
							clientCode: existingApp.clientCode,
							serverCode: existingApp.serverCode,
							serverCodeId: existingApp.serverCodeId,
							parameters: existingApp.parameters,
							hidden: existingApp.hidden,
						})
					} catch {
						// Preserve the original runner configuration failure.
					}
				}
				throw cause
			}

			try {
				if (!hidden) {
					await upsertUiArtifactVector(ctx.env, {
						appId,
						userId: user.userId,
						embedText: buildUiArtifactEmbedText({
							title: args.title,
							description: args.description,
							hasServerCode: args.serverCode != null,
							parameters,
						}),
					})
				} else if (isUpdate) {
					await deleteUiArtifactVector(ctx.env, appId)
				}
			} catch (cause) {
				if (!isUpdate) {
					await deleteUiArtifact(ctx.env.APP_DB, user.userId, appId)
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
						appId,
						isUpdate,
					},
				})
			}

			return {
				app_id: appId,
				server_code_id: serverCodeId,
				has_server_code: args.serverCode != null,
				hosted_url: buildSavedUiUrl(ctx.callerContext.baseUrl, appId),
				parameters,
				hidden,
			}
		},
	},
)
