import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import {
	parseUiArtifactParameters,
	uiArtifactParameterSchema,
} from '#mcp/ui-artifact-parameters.ts'
import { listUiArtifactsByUserId } from '#mcp/ui-artifacts-repo.ts'
import { resolveSavedAppSource } from '#worker/repo/app-source.ts'
import { getEntitySourceById } from '#worker/repo/entity-sources.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'

const outputSchema = z.object({
	apps: z.array(
		z.object({
			app_id: z.string(),
			title: z.string(),
			description: z.string(),
			has_server_code: z.boolean(),
			server_code_id: z.string(),
			parameters: z.array(uiArtifactParameterSchema).nullable(),
			hidden: z.boolean(),
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
			const resolvedApps = await Promise.all(
				rows.map(async (row) => {
					if (row.hasServerCode == null) {
						const resolved = await resolveSavedAppSource({
							env: ctx.env,
							baseUrl: ctx.callerContext.baseUrl,
							artifact: row,
						})
						return {
							row,
							title: resolved.title,
							description: resolved.description,
							hidden: resolved.hidden,
							hasServerCode: resolved.serverCode != null,
							serverCodeId: resolved.serverCodeId,
						}
					}
					const source = await getEntitySourceById(
						ctx.env.APP_DB,
						row.sourceId,
					)
					return {
						row,
						title: row.title,
						description: row.description,
						hidden: row.hidden,
						hasServerCode: row.hasServerCode,
						serverCodeId: source?.published_commit ?? row.sourceId,
					}
				}),
			)
			return {
				apps: resolvedApps.map(
					({ row, title, description, hidden, hasServerCode, serverCodeId }) => ({
						app_id: row.id,
						title,
						description,
						has_server_code: hasServerCode ?? false,
						server_code_id: serverCodeId,
						parameters: parseUiArtifactParameters(row.parameters),
						hidden,
						created_at: row.created_at,
						updated_at: row.updated_at,
					}),
				),
			}
		},
	},
)
