import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { getUiArtifactById } from '#mcp/ui-artifacts-repo.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { uiArtifactParameterSchema } from '#mcp/ui-artifact-parameters.ts'
import { resolveSavedAppSource } from '#worker/repo/app-source.ts'

const outputSchema = z.object({
	app_id: z.string(),
	title: z.string(),
	description: z.string(),
	parameters: z.array(uiArtifactParameterSchema).nullable(),
	hidden: z.boolean(),
	client_code: z
		.string()
		.describe('Client source code rendered inside the generic shell.'),
	server_code: z
		.string()
		.nullable()
		.describe('Optional Durable Object server code for the app backend.'),
	server_code_id: z
		.string()
		.describe('Dynamic worker cache key for the current server code revision.'),
	created_at: z.string(),
	updated_at: z.string(),
	source_id: z.string(),
	published_commit: z.string(),
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
			const resolved = await resolveSavedAppSource({
				env: ctx.env,
				baseUrl: ctx.callerContext.baseUrl,
				artifact: row,
			})
			return {
				app_id: row.id,
				title: resolved.title,
				description: resolved.description,
				parameters: resolved.parameters,
				hidden: resolved.hidden,
				client_code: resolved.clientCode,
				server_code: resolved.serverCode,
				server_code_id: resolved.serverCodeId,
				created_at: row.created_at,
				updated_at: row.updated_at,
				source_id: resolved.sourceId,
				published_commit: resolved.publishedCommit,
			}
		},
	},
)
