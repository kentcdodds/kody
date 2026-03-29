import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import {
	getUiArtifactById,
	parseStringArray,
} from '#mcp/ui-artifacts-repo.ts'
import {
	parseUiArtifactParameters,
	uiArtifactParameterSchema,
} from '#mcp/ui-artifact-parameters.ts'
import { uiSaveAppCapability } from './ui-save-app.ts'

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
		parameters: z
			.array(uiArtifactParameterSchema)
			.optional()
			.describe(
				'Optional parameter definitions for reusable saved apps. Resolved values are exposed at runtime on the imported `kodyWidget.params` API from `@kody/ui-utils`.',
			),
	})
	.refine(
		(value) =>
			value.title !== undefined ||
			value.description !== undefined ||
			value.keywords !== undefined ||
			value.code !== undefined ||
			value.runtime !== undefined ||
			value.search_text !== undefined ||
			value.parameters !== undefined,
		{
			message: 'Provide at least one field to update.',
		},
	)

const outputSchema = z.object({
	app_id: z.string(),
	runtime: z.enum(['html', 'javascript']),
	hosted_url: z.string().url(),
	parameters: z.array(uiArtifactParameterSchema).nullable(),
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
			const existing = await getUiArtifactById(
				ctx.env.APP_DB,
				user.userId,
				args.app_id,
			)
			if (!existing) {
				throw new Error('Saved UI artifact not found for this user.')
			}

			const existingParameters =
				parseUiArtifactParameters(existing.parameters) ?? undefined
			return uiSaveAppCapability.handler(
				{
					app_id: args.app_id,
					title: args.title ?? existing.title,
					description: args.description ?? existing.description,
					keywords: args.keywords ?? parseStringArray(existing.keywords),
					code: args.code ?? existing.code,
					runtime: args.runtime ?? existing.runtime,
					search_text: args.search_text ?? existing.search_text ?? undefined,
					parameters: args.parameters ?? existingParameters,
				},
				ctx,
			)
		},
	},
)
