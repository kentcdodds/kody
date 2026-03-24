import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { getUiArtifactById } from '#mcp/ui-artifacts-repo.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'

function parseStringArray(raw: string): Array<string> {
	try {
		const value = JSON.parse(raw) as unknown
		if (!Array.isArray(value)) return []
		return value.filter((entry): entry is string => typeof entry === 'string')
	} catch {
		return []
	}
}

const outputSchema = z.object({
	app_id: z.string(),
	title: z.string(),
	description: z.string(),
	keywords: z.array(z.string()),
	code: z
		.string()
		.describe('Generated UI source code to render inside the generic shell.'),
	runtime: z.string(),
	search_text: z.string().nullable(),
	created_at: z.string(),
	updated_at: z.string(),
})

export const uiGetAppCapability = defineDomainCapability(
	capabilityDomainNames.apps,
	{
		name: 'ui_get_app',
		description:
			'Load a saved UI artifact for the signed-in user, including source code and metadata.',
		keywords: ['ui', 'app', 'artifact', 'load', 'read', 'source'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			app_id: z
				.string()
				.min(1)
				.describe('Saved UI artifact id returned by ui_save_app.'),
		}),
		outputSchema,
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			const row = await getUiArtifactById(
				ctx.env.APP_DB,
				user.userId,
				args.app_id,
			)
			if (!row) {
				throw new Error('Saved UI artifact not found for this user.')
			}
			return {
				app_id: row.id,
				title: row.title,
				description: row.description,
				keywords: parseStringArray(row.keywords),
				code: row.code,
				runtime: row.runtime,
				search_text: row.search_text,
				created_at: row.created_at,
				updated_at: row.updated_at,
			}
		},
	},
)
