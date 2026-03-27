import { z } from 'zod'
import { buildSavedUiUrl } from '#worker/ui-artifact-urls.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { deleteUiArtifact, insertUiArtifact } from '#mcp/ui-artifacts-repo.ts'
import { buildUiArtifactEmbedText } from '#mcp/ui-artifacts-embed.ts'
import { upsertUiArtifactVector } from '#mcp/ui-artifacts-vectorize.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import {
	normalizeUiArtifactParameters,
	uiArtifactParameterSchema,
} from '#mcp/ui-artifact-parameters.ts'

const inputSchema = z.object({
	title: z.string().min(1).describe('Short title for the saved UI artifact.'),
	description: z
		.string()
		.min(1)
		.describe('What the saved app does and when it is useful.'),
	keywords: z
		.array(z.string())
		.describe('Extra search keywords for discovery in the search tool.'),
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
	search_text: z
		.string()
		.optional()
		.describe(
			'Optional retrieval-only text that improves search recall without being part of the visible app description.',
		),
	parameters: z
		.array(uiArtifactParameterSchema)
		.optional()
		.describe(
			'Optional parameter definitions for reusable saved apps. Resolved values are exposed at runtime on window.kodyWidget.params.',
		),
})

const outputSchema = z.object({
	app_id: z.string(),
	runtime: z.enum(['html', 'javascript']),
	hosted_url: z.string().url(),
	parameters: z.array(uiArtifactParameterSchema).nullable(),
})

export const uiSaveAppCapability = defineDomainCapability(
	capabilityDomainNames.apps,
	{
		name: 'ui_save_app',
		description:
			'Save a generated UI artifact for the signed-in user so it can be reopened later by app_id without sending the source back through the model context.',
		keywords: ['ui', 'app', 'artifact', 'save', 'persist', 'mcp app'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema,
		outputSchema,
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			const appId = crypto.randomUUID()
			const now = new Date().toISOString()
			const parameters = normalizeUiArtifactParameters(args.parameters)
			await insertUiArtifact(ctx.env.APP_DB, {
				id: appId,
				user_id: user.userId,
				title: args.title,
				description: args.description,
				keywords: JSON.stringify(args.keywords),
				code: args.code,
				runtime: args.runtime,
				search_text: args.search_text ?? null,
				parameters: parameters ? JSON.stringify(parameters) : null,
				created_at: now,
				updated_at: now,
			})

			try {
				await upsertUiArtifactVector(ctx.env, {
					appId,
					userId: user.userId,
					embedText: buildUiArtifactEmbedText({
						title: args.title,
						description: args.description,
						keywords: args.keywords,
						searchText: args.search_text ?? null,
						runtime: args.runtime,
						parameters,
					}),
				})
			} catch (cause) {
				await deleteUiArtifact(ctx.env.APP_DB, user.userId, appId)
				throw cause
			}

			return {
				app_id: appId,
				runtime: args.runtime,
				hosted_url: buildSavedUiUrl(ctx.callerContext.baseUrl, appId),
				parameters,
			}
		},
	},
)
