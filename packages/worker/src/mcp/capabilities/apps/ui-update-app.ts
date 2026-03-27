import { z } from 'zod'
import { buildSavedUiUrl } from '#worker/ui-artifact-urls.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { buildUiArtifactEmbedText } from '#mcp/ui-artifacts-embed.ts'
import { getUiArtifactById, updateUiArtifact } from '#mcp/ui-artifacts-repo.ts'
import { upsertUiArtifactVector } from '#mcp/ui-artifacts-vectorize.ts'

function parseStringArray(raw: string): Array<string> {
	try {
		const value = JSON.parse(raw) as unknown
		if (!Array.isArray(value)) return []
		return value.filter((entry): entry is string => typeof entry === 'string')
	} catch {
		return []
	}
}

const inputSchema = z
	.object({
		app_id: z
			.string()
			.min(1)
			.describe('Saved UI artifact id returned by ui_save_app.'),
		title: z
			.string()
			.min(1)
			.optional()
			.describe('Short title for the saved UI artifact.'),
		description: z
			.string()
			.min(1)
			.optional()
			.describe('What the saved app does and when it is useful.'),
		keywords: z
			.array(z.string())
			.optional()
			.describe('Extra search keywords for discovery in the search tool.'),
		code: z
			.string()
			.min(1)
			.optional()
			.describe(
				'App source for the generic MCP UI shell. Prefer a self-contained HTML document or fragment so the generated app owns the visible UI. Legacy `javascript` source is still supported for previously saved apps.',
			),
		runtime: z
			.enum(['html', 'javascript'])
			.optional()
			.describe(
				'Source format accepted by the generic UI shell. Prefer `html`; `javascript` is kept for legacy saved apps.',
			),
		search_text: z
			.string()
			.optional()
			.describe(
				'Optional retrieval-only text that improves search recall without being part of the visible app description.',
			),
	})
	.refine(
		(value) =>
			value.title !== undefined ||
			value.description !== undefined ||
			value.keywords !== undefined ||
			value.code !== undefined ||
			value.runtime !== undefined ||
			value.search_text !== undefined,
		{
			message: 'Provide at least one field to update.',
		},
	)

const outputSchema = z.object({
	app_id: z.string(),
	runtime: z.enum(['html', 'javascript']),
	hosted_url: z.string().url(),
})

export const uiUpdateAppCapability = defineDomainCapability(
	capabilityDomainNames.apps,
	{
		name: 'ui_update_app',
		description:
			'Update an existing saved UI artifact owned by the signed-in user. Only the fields provided will be changed.',
		keywords: ['ui', 'app', 'artifact', 'update', 'edit', 'modify'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema,
		outputSchema,
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			const updates: Parameters<typeof updateUiArtifact>[3] = {}

			if (args.title !== undefined) {
				updates.title = args.title
			}
			if (args.description !== undefined) {
				updates.description = args.description
			}
			if (args.keywords !== undefined) {
				updates.keywords = JSON.stringify(args.keywords)
			}
			if (args.code !== undefined) {
				updates.code = args.code
			}
			if (args.runtime !== undefined) {
				updates.runtime = args.runtime
			}
			if (args.search_text !== undefined) {
				updates.search_text = args.search_text
			}

			const updated = await updateUiArtifact(
				ctx.env.APP_DB,
				user.userId,
				args.app_id,
				updates,
			)
			if (!updated) {
				throw new Error('Saved UI artifact not found for this user.')
			}

			const refreshed = await getUiArtifactById(
				ctx.env.APP_DB,
				user.userId,
				args.app_id,
			)
			if (!refreshed) {
				throw new Error('Saved UI artifact not found after update.')
			}

			await upsertUiArtifactVector(ctx.env, {
				appId: refreshed.id,
				userId: user.userId,
				embedText: buildUiArtifactEmbedText({
					title: refreshed.title,
					description: refreshed.description,
					keywords: parseStringArray(refreshed.keywords),
					searchText: refreshed.search_text,
					runtime: refreshed.runtime,
				}),
			})

			return {
				app_id: refreshed.id,
				runtime: refreshed.runtime,
				hosted_url: buildSavedUiUrl(ctx.callerContext.baseUrl, refreshed.id),
			}
		},
	},
)
