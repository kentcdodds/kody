import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import {
	deleteUiArtifact,
	insertUiArtifact,
} from '#mcp/ui-artifacts-repo.ts'
import { buildUiArtifactEmbedText } from '#mcp/ui-artifacts-embed.ts'
import { upsertUiArtifactVector } from '#mcp/ui-artifacts-vectorize.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'

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
			'App source for the generic MCP UI shell. For v1, this should be a single JavaScript module string that renders into `#app`.',
		),
	runtime: z
		.enum(['javascript'])
		.default('javascript')
		.describe('Source format accepted by the generic UI shell.'),
	search_text: z
		.string()
		.optional()
		.describe(
			'Optional retrieval-only text that improves search recall without being part of the visible app description.',
		),
})

const outputSchema = z.object({
	app_id: z.string(),
	runtime: z.enum(['javascript']),
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
			await insertUiArtifact(ctx.env.APP_DB, {
				id: appId,
				user_id: user.userId,
				title: args.title,
				description: args.description,
				keywords: JSON.stringify(args.keywords),
				code: args.code,
				runtime: args.runtime,
				search_text: args.search_text ?? null,
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
					}),
				})
			} catch (cause) {
				await deleteUiArtifact(ctx.env.APP_DB, user.userId, appId)
				throw cause
			}

			return {
				app_id: appId,
				runtime: args.runtime,
			}
		},
	},
)
