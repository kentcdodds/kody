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
			'HTML source for the generic MCP UI shell. Provide a self-contained HTML document or fragment. If the app needs browser-side logic, include it with `<script type="module">...</script>` inside the HTML.',
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
			const nextServerCode = args.serverCode ?? null
			const parameters = normalizeUiArtifactParameters(args.parameters)
			const serializedParameters = parameters
				? JSON.stringify(parameters)
				: null
			let hidden: boolean
			let existingApp: Awaited<ReturnType<typeof getUiArtifactById>> | null =
				null

			async function saveAndIndexApp(input: {
				appId: string
				serverCodeId: string
				hidden: boolean
				existingApp: Awaited<ReturnType<typeof getUiArtifactById>> | null
			}) {
				try {
					await configureSavedAppRunner({
						env: ctx.env,
						appId: input.appId,
						userId: user.userId,
						baseUrl: ctx.callerContext.baseUrl,
						serverCode: nextServerCode,
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
						])
					} else if (input.existingApp) {
						try {
							await updateUiArtifact(ctx.env.APP_DB, user.userId, input.appId, {
								title: input.existingApp.title,
								description: input.existingApp.description,
								clientCode: input.existingApp.clientCode,
								serverCode: input.existingApp.serverCode,
								serverCodeId: input.existingApp.serverCodeId,
								parameters: input.existingApp.parameters,
								hidden: input.existingApp.hidden,
							})
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
								title: args.title,
								description: args.description,
								hasServerCode: nextServerCode != null,
								parameters,
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
					has_server_code: nextServerCode != null,
					hosted_url: buildSavedUiUrl(ctx.callerContext.baseUrl, input.appId),
					parameters,
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
				const serverCodeChanged = nextServerCode !== existingApp.serverCode
				const serverCodeId = serverCodeChanged
					? crypto.randomUUID()
					: existingApp.serverCodeId
				const updated = await updateUiArtifact(
					ctx.env.APP_DB,
					user.userId,
					appId,
					{
						title: args.title,
						description: args.description,
						clientCode: args.clientCode,
						serverCode: nextServerCode,
						serverCodeId,
						parameters: serializedParameters,
						hidden: args.hidden,
					},
				)
				if (!updated) {
					throw new Error('Saved UI artifact not found for this user.')
				}
				hidden = args.hidden ?? existingApp.hidden
				return await saveAndIndexApp({
					appId,
					serverCodeId,
					hidden,
					existingApp,
				})
			} else {
				const serverCodeId = crypto.randomUUID()
				hidden = args.hidden ?? true
				const now = new Date().toISOString()
				await insertUiArtifact(ctx.env.APP_DB, {
					id: appId,
					user_id: user.userId,
					title: args.title,
					description: args.description,
					clientCode: args.clientCode,
					serverCode: nextServerCode,
					serverCodeId,
					parameters: serializedParameters,
					hidden,
					created_at: now,
					updated_at: now,
				})
				return await saveAndIndexApp({
					appId,
					serverCodeId,
					hidden,
					existingApp,
				})
			}
		},
	},
)
