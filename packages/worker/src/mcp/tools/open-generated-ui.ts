import { registerAppTool } from '@modelcontextprotocol/ext-apps/server'
import { type ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { generatedUiRuntimeResourceUri } from '#mcp/apps/generated-ui-runtime-html-entry.ts'
import { createGeneratedUiAppSession } from '#mcp/generated-ui-app-session.ts'
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
	appendToolContent,
	prependToolMetadataContent,
} from './tool-response-content.ts'

const openGeneratedUiTool = {
	name: 'open_generated_ui',
	title: 'Open Generated UI',
	description: `
Open the MCP App runtime. Pass exactly one of \`code\` (inline HTML fragment or
full document), \`package_id\`, or \`kody_id\` (saved package app identity).

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
	})
	.refine(
		(value) =>
			(value.code ? 1 : 0) +
				(value.package_id ? 1 : 0) +
				(value.kody_id ? 1 : 0) ===
			1,
		{
			message: 'Provide exactly one of `code`, `package_id`, or `kody_id`.',
			path: ['code'],
		},
	)

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
			const packageId = args.package_id ?? null
			const kodyId = args.kody_id ?? null
			const title = args.title ?? null
			const description = args.description ?? null
			let savedPackage:
				| Awaited<ReturnType<typeof getSavedPackageById>>
				| Awaited<ReturnType<typeof getSavedPackageByKodyId>>
				| null = null
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
			const hostedUrl = savedPackage
				? `${agent.requireDomain()}/packages/${encodeURIComponent(savedPackage.kodyId)}`
				: null
			const appSession =
				callerContext.user != null
					? await createGeneratedUiAppSession({
							env: agent.getEnv(),
							baseUrl: callerContext.baseUrl,
							user: callerContext.user,
							appId: savedPackage?.id ?? null,
							homeConnectorId: callerContext.homeConnectorId ?? null,
						})
					: null
			const structuredContent = {
				conversationId,
				widget: 'generated_ui' as const,
				resourceUri: generatedUiRuntimeResourceUri,
				renderSource: savedPackage
					? ('saved_package' as const)
					: ('inline_code' as const),
				appId: savedPackage?.id ?? null,
				title,
				description,
				runtime: 'html' as const,
				sourceCode: args.code ?? null,
				hostedUrl,
				appSession,
				appBackend: null,
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
								text: savedPackage
									? `## Generated UI ready\n\nThe hosted package app is ready.\n\nIf the host does not display the attached UI correctly, open the hosted package URL: ${hostedUrl}`
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
