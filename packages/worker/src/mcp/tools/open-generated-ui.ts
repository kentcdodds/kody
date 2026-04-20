import { registerAppTool } from '@modelcontextprotocol/ext-apps/server'
import { type ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { generatedUiRuntimeResourceUri } from '#mcp/apps/generated-ui-runtime-html-entry.ts'
import {
	buildSavedAppBackendBasePath,
	createGeneratedUiAppSession,
} from '#mcp/generated-ui-app-session.ts'
import {
	getSavedPackageById,
	getSavedPackageByKodyId,
} from '#worker/package-registry/repo.ts'
import { type McpRegistrationAgent } from '#mcp/mcp-registration-agent.ts'
import {
	conversationIdInputField,
	memoryContextInputField,
	resolveConversationId,
} from '#mcp/tools/tool-call-context.ts'
import {
	loadRelevantMemoriesForTool,
	formatSurfacedMemoriesMarkdown,
	buildMemoryStructuredContent,
} from '#mcp/tools/memory-tool-context.ts'
import {
	applyUiArtifactParameters,
	parseUiArtifactParameters,
} from '#mcp/ui-artifact-parameters.ts'
import { getUiArtifactById } from '#mcp/ui-artifacts-repo.ts'
import { hasUiArtifactServerCode } from '#mcp/ui-artifacts-types.ts'
import { buildSavedUiUrl } from '#worker/ui-artifact-urls.ts'
import {
	appendToolContent,
	prependToolMetadataContent,
} from './tool-response-content.ts'

const openGeneratedUiTool = {
	name: 'open_generated_ui',
	title: 'Open Generated UI',
	description: `
Open the MCP App runtime. Pass exactly one of \`code\` (inline HTML fragment or
full document), \`app_id\` (legacy saved UI artifact), \`package_id\`, or
\`kody_id\` (saved package app identity). \`params\` currently applies only to
legacy \`app_id\` flows.

Use for sensitive input (never ask the user to paste credentials in chat).
Recoverable errors: show in the UI and \`sendMessage(...)\` with the next step.
If the package app depends on a third-party integration, load
\`kody_official_guide\` (\`guide: "integration_bootstrap"\`) before building or
saving the downstream package.

Persist packages with \`package_save\`; discover them with \`search\` or
\`package_list\`.

https://github.com/kentcdodds/kody/blob/main/docs/use/execute.md
	`.trim(),
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	} satisfies ToolAnnotations,
} as const

const inputSchema = z
	.object({
		code: z
			.string()
			.min(1)
			.optional()
			.describe(
				'Inline HTML source to render immediately. Provide an HTML fragment or full HTML document.',
			),
		app_id: z
			.string()
			.min(1)
			.optional()
			.describe('Legacy saved UI artifact id to reopen.'),
		package_id: z
			.string()
			.min(1)
			.optional()
			.describe('Saved package id to reopen when the package defines kody.app.'),
		kody_id: z
			.string()
			.min(1)
			.optional()
			.describe(
				'Saved package kody id to reopen when the package defines kody.app.',
			),
		title: z
			.string()
			.min(1)
			.optional()
			.describe('Optional display title for the current render session.'),
		description: z
			.string()
			.min(1)
			.optional()
			.describe('Optional short description for the current render session.'),
		conversationId: conversationIdInputField,
		memoryContext: memoryContextInputField,
		params: z
			.record(z.string(), z.unknown())
			.optional()
			.describe(
				'Optional runtime parameter values for a legacy saved app (validated against its saved parameter definitions).',
			),
	})
	.refine(
		(value) =>
			(value.code ? 1 : 0) +
				(value.app_id ? 1 : 0) +
				(value.package_id ? 1 : 0) +
				(value.kody_id ? 1 : 0) ===
			1,
		{
			message:
				'Provide exactly one of `code`, `app_id`, `package_id`, or `kody_id`.',
			path: ['code'],
		},
	)
	.refine((value) => !(value.code && value.params), {
		message: '`params` is only supported with `app_id`.',
		path: ['code'],
	})
	.refine((value) => !(value.package_id && value.params), {
		message: '`params` is only supported with `app_id`.',
		path: ['params'],
	})
	.refine((value) => !(value.kody_id && value.params), {
		message: '`params` is only supported with `app_id`.',
		path: ['params'],
	})

export async function registerOpenGeneratedUiTool(agent: McpRegistrationAgent) {
	registerAppTool(
		agent.server,
		openGeneratedUiTool.name,
		{
			title: openGeneratedUiTool.title,
			description: openGeneratedUiTool.description,
			inputSchema,
			annotations: openGeneratedUiTool.annotations,
			_meta: {
				ui: {
					resourceUri: generatedUiRuntimeResourceUri,
				},
			},
		},
		async (args) => {
			const callerContext = agent.getCallerContext()
			const conversationId = resolveConversationId(args.conversationId)
			const appId = args.app_id ?? null
			const packageId = args.package_id ?? null
			const kodyId = args.kody_id ?? null
			const title = args.title ?? null
			const description = args.description ?? null
			let resolvedParams: Record<string, unknown> | undefined
			let savedApp: Awaited<ReturnType<typeof getUiArtifactById>> | null = null
			let savedPackage:
				| Awaited<ReturnType<typeof getSavedPackageById>>
				| Awaited<ReturnType<typeof getSavedPackageByKodyId>>
				| null = null
			if (appId) {
				if (!callerContext.user) {
					throw new Error(
						'Authentication required to access saved UI artifacts.',
					)
				}
				savedApp = await getUiArtifactById(
					agent.getEnv().APP_DB,
					callerContext.user.userId,
					appId,
				)
				if (!savedApp) {
					throw new Error('Saved UI artifact not found for this user.')
				}
				resolvedParams = applyUiArtifactParameters({
					definitions: parseUiArtifactParameters(savedApp.parameters),
					values: args.params,
				})
			}
			if (packageId || kodyId) {
				if (!callerContext.user) {
					throw new Error('Authentication required to access saved packages.')
				}
				savedPackage = packageId
					? await getSavedPackageById(agent.getEnv().APP_DB, {
							userId: callerContext.user.userId,
							packageId,
						})
					: await getSavedPackageByKodyId(agent.getEnv().APP_DB, {
							userId: callerContext.user.userId,
							kodyId: kodyId!,
						})
				if (!savedPackage || !savedPackage.hasApp) {
					throw new Error(
						'Saved package app not found for this user or the package does not define kody.app.',
					)
				}
			}
			const hostedUrl = appId
				? buildSavedUiUrl(agent.requireDomain(), appId, {
						params: resolvedParams,
					})
				: savedPackage
					? `${agent.requireDomain()}/packages/${encodeURIComponent(savedPackage.kodyId)}`
				: null
			const appSession =
				callerContext.user != null
					? await createGeneratedUiAppSession({
							env: agent.getEnv(),
							baseUrl: callerContext.baseUrl,
							user: callerContext.user,
							appId: appId ?? savedPackage?.id ?? null,
							homeConnectorId: callerContext.homeConnectorId ?? null,
							params: resolvedParams,
						})
					: null
			const structuredContent = {
				conversationId,
				widget: 'generated_ui' as const,
				resourceUri: generatedUiRuntimeResourceUri,
				renderSource: appId
					? ('saved_app' as const)
					: savedPackage
						? ('saved_package' as const)
						: ('inline_code' as const),
				appId: appId ?? savedPackage?.id ?? null,
				title,
				description,
				runtime: 'html' as const,
				sourceCode: args.code ?? null,
				params: resolvedParams,
				hostedUrl,
				appSession,
				appBackend: hasUiArtifactServerCode(savedApp?.hasServerCode)
					? {
							basePath: buildSavedAppBackendBasePath(savedApp.id),
							facetNames: ['main'],
						}
					: null,
			}
			const memoryResult = await loadRelevantMemoriesForTool({
				env: agent.getEnv(),
				callerContext,
				conversationId,
				memoryContext: args.memoryContext,
			})
			return {
				content: prependToolMetadataContent(
					conversationId,
					appendToolContent(
						[
							{
								type: 'text',
								text: appId || savedPackage
									? `## Generated UI ready\n\nThe generic app runtime is attached to this tool call and will load the saved UI surface inside the widget runtime.\n\nIf the host does not display the attached UI correctly, open the hosted fallback URL: ${hostedUrl}`
									: '## Generated UI ready\n\nThe generic app runtime is attached to this tool call and will render the provided inline source inside the widget runtime.',
							},
						],
						formatSurfacedMemoriesMarkdown(memoryResult),
					),
				),
				structuredContent: {
					...structuredContent,
					...buildMemoryStructuredContent(memoryResult),
				},
			}
		},
	)
}
