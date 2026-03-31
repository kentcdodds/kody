import { z } from 'zod'
import { buildSavedUiUrl } from '#worker/ui-artifact-urls.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { errorFields, logMcpEvent } from '#mcp/observability.ts'
import {
	deleteUiArtifact,
	insertUiArtifact,
	updateUiArtifact,
} from '#mcp/ui-artifacts-repo.ts'
import { buildUiArtifactEmbedText } from '#mcp/ui-artifacts-embed.ts'
import {
	deleteUiArtifactVector,
	upsertUiArtifactVector,
} from '#mcp/ui-artifacts-vectorize.ts'
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
	code: z
		.string()
		.min(1)
		.describe(
			'App source for the generic MCP UI shell. Prefer a self-contained HTML document or fragment so the generated app owns the visible UI. Legacy `javascript` source is still supported for previously saved apps.',
		),
	runtime: z
		.enum(['html', 'javascript'])
		.default('html')
		.describe(
			'Source format accepted by the generic UI shell. Prefer `html`; `javascript` is kept for legacy saved apps.',
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
	runtime: z.enum(['html', 'javascript']),
	hosted_url: z.string().url(),
	parameters: z.array(uiArtifactParameterSchema).nullable(),
	hidden: z.boolean(),
})

export const uiSaveAppCapability = defineDomainCapability(
	capabilityDomainNames.apps,
	{
		name: 'ui_save_app',
		description:
			'Create or replace a saved UI artifact for the signed-in user so it can be reopened later by app_id without sending the source back through the model context.',
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
			const parameters = normalizeUiArtifactParameters(args.parameters)
			const hidden = args.hidden ?? true
			const serializedParameters = parameters
				? JSON.stringify(parameters)
				: null

			if (isUpdate) {
				const updated = await updateUiArtifact(
					ctx.env.APP_DB,
					user.userId,
					appId,
					{
						title: args.title,
						description: args.description,
						code: args.code,
						runtime: args.runtime,
						parameters: serializedParameters,
						hidden,
					},
				)
				if (!updated) {
					throw new Error('Saved UI artifact not found for this user.')
				}
			} else {
				const now = new Date().toISOString()
				await insertUiArtifact(ctx.env.APP_DB, {
					id: appId,
					user_id: user.userId,
					title: args.title,
					description: args.description,
					code: args.code,
					runtime: args.runtime,
					parameters: serializedParameters,
					hidden,
					created_at: now,
					updated_at: now,
				})
			}

			try {
				if (!hidden) {
					await upsertUiArtifactVector(ctx.env, {
						appId,
						userId: user.userId,
						embedText: buildUiArtifactEmbedText({
							title: args.title,
							description: args.description,
							code: args.code,
							runtime: args.runtime,
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
				runtime: args.runtime,
				hosted_url: buildSavedUiUrl(ctx.callerContext.baseUrl, appId),
				parameters,
				hidden,
			}
		},
	},
)
