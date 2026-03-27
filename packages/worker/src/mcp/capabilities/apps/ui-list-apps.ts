import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import {
	parseUiArtifactParameters,
	uiArtifactParameterSchema,
} from '#mcp/ui-artifact-parameters.ts'
import {
	listUiArtifactsByUserId,
	parseStringArray,
} from '#mcp/ui-artifacts-repo.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'

const outputSchema = z.object({
	apps: z.array(
		z.object({
			app_id: z.string(),
			title: z.string(),
			description: z.string(),
			keywords: z.array(z.string()),
			runtime: z.string(),
			parameters: z.array(uiArtifactParameterSchema).nullable(),
			created_at: z.string(),
			updated_at: z.string(),
		}),
	),
})

export const uiListAppsCapability = defineDomainCapability(
	capabilityDomainNames.apps,
	{
		name: 'ui_list_apps',
		description:
			'List saved UI app artifacts for the signed-in user so the model can reuse them by app_id without reloading source code.',
		keywords: ['ui', 'apps', 'list', 'saved apps', 'artifacts'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({}),
		outputSchema,
		async handler(_args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			const rows = await listUiArtifactsByUserId(ctx.env.APP_DB, user.userId)
			return {
				apps: rows.map((row) => ({
					app_id: row.id,
					title: row.title,
					description: row.description,
					keywords: parseStringArray(row.keywords),
					runtime: row.runtime,
					parameters: parseUiArtifactParameters(row.parameters),
					created_at: row.created_at,
					updated_at: row.updated_at,
				})),
			}
		},
	},
)
