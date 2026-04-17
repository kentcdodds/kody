import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { getUiArtifactById } from '#mcp/ui-artifacts-repo.ts'
import { uiArtifactParameterSchema } from '#mcp/ui-artifact-parameters.ts'
import { requireMcpUser } from '../meta/require-user.ts'
import { resolveSavedAppSource } from '#worker/repo/app-source.ts'

const outputSchema = z.object({
	app_id: z.string(),
	title: z.string(),
	description: z.string(),
	client_code: z.string(),
	server_code: z.string().nullable(),
	server_code_id: z.string(),
	parameters: z.array(uiArtifactParameterSchema).nullable(),
	hidden: z.boolean(),
	source_id: z.string(),
	published_commit: z.string(),
})

export const uiLoadAppSourceCapability = defineDomainCapability(
	capabilityDomainNames.apps,
	{
		name: 'ui_load_app_source',
		description:
			'Load saved UI artifact source for an authenticated user. Intended for MCP Apps to reopen a saved app by id without surfacing the source back through model search results.',
		keywords: ['ui', 'app', 'artifact', 'load', 'source', 'reopen'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			app_id: z
				.string()
				.min(1)
				.describe('Saved app artifact id returned by ui_save_app.'),
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
				throw new Error('Saved app not found for this user.')
			}
			const resolved = await resolveSavedAppSource({
				env: ctx.env,
				baseUrl: ctx.callerContext.baseUrl,
				artifact: row,
			})
			return {
				app_id: row.id,
				title: resolved.title,
				description: resolved.description,
				client_code: resolved.clientCode,
				server_code: resolved.serverCode,
				server_code_id: resolved.serverCodeId,
				parameters: resolved.parameters,
				hidden: resolved.hidden,
				source_id: resolved.sourceId,
				published_commit: resolved.publishedCommit,
			}
		},
	},
)
