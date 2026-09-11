import { resolveHostedPackageAppUrl } from '@kody-internal/shared/public-urls.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { type McpRegistrationAgent } from '#mcp/mcp-registration-agent.ts'
import { getPackageAppBaseUrl } from '#worker/app-base-url.ts'
import { importGuideCatalog } from '#worker/guide-catalog-modules.ts'
import { legacyGuideIdAliases } from '#universal/docs-nav.ts'
import {
	getJoinedIntegration,
	toJoinedIntegrationConfig,
} from '#worker/integrations/service.ts'
import { applySavedPackageForkListingAncestry } from '#worker/community/fork-listing-relation.ts'
import {
	getSavedPackageWithCommunityProvenanceById,
	getSavedPackageWithCommunityProvenanceByKodyId,
} from '#worker/package-registry/repo.ts'
import { findPlatformPackageByRef } from '#worker/package-registry/platform-packages.ts'
import { loadPackageSourceBySourceId } from '#worker/package-registry/source.ts'

import { collectIntegrationPackageSuggestions } from './integration-package-suggestions.ts'
import { parseEntityRef } from './search-format.ts'
import {
	buildMcpServerToolIndex,
	findSynthesizedMcpServer,
	findWrappingPackageForMcpServer,
	listSynthesizedMcpServers,
	mcpServerUsage,
} from './search-mcp-servers.ts'
import { countRelatedCapabilityOperations } from './search-related-capabilities.ts'
import { type SearchRowsAndRegistry } from './search-types.ts'

export async function resolveEntityDetail(input: {
	agent: McpRegistrationAgent
	callerContext: ReturnType<McpRegistrationAgent['getCallerContext']>
	userId: string | null
	username: string | null
	entity: string
	searchRows: SearchRowsAndRegistry
}) {
	const ref = parseEntityRef(input.entity)
	if (ref.section && ref.type !== 'guide') {
		throw new McpCallerError(
			'Section fragments are only supported on guide entities. Use "{id}:guide#{heading}".',
		)
	}
	if (ref.type === 'mcp-server') {
		const server = findSynthesizedMcpServer(
			listSynthesizedMcpServers(input.searchRows.registry),
			ref.id,
		)
		if (!server) {
			throw new McpCallerError('MCP server not found.')
		}
		return {
			type: 'mcp-server' as const,
			id: server.kodyName,
			title: server.serverName,
			description: server.description,
			domain: server.domain,
			kodyName: server.kodyName,
			serverName: server.serverName,
			serverId: server.serverId,
			instructions: server.instructions,
			usage: mcpServerUsage(server.kodyName),
			tools: buildMcpServerToolIndex(server),
			wrappingPackage: findWrappingPackageForMcpServer(
				server,
				input.searchRows.packageRows,
			),
		}
	}

	if (ref.type === 'capability') {
		const spec = input.searchRows.registry.capabilitySpecs[ref.id]
		if (!spec) {
			throw new McpCallerError('Capability not found.')
		}
		const relatedOperationCount = countRelatedCapabilityOperations({
			spec,
			registry: input.searchRows.registry,
		})
		return {
			type: 'capability' as const,
			id: ref.id,
			title: spec.name,
			description: spec.description,
			spec,
			...(relatedOperationCount > 0 ? { relatedOperationCount } : {}),
		}
	}

	if (ref.type === 'guide') {
		const { guides } = await importGuideCatalog()
		// Ids of docs merged into another doc keep resolving to the absorbing
		// guide (scoped to the heading that took the content).
		const alias = legacyGuideIdAliases[ref.id]
		const guideId = alias?.id ?? ref.id
		const section = ref.section ?? alias?.section
		const guide = guides.find((candidate) => candidate.id === guideId) ?? null
		if (!guide) {
			throw new McpCallerError('Guide not found.')
		}
		return {
			type: 'guide' as const,
			id: guide.id,
			title: guide.title,
			description: guide.summary,
			body: guide.body,
			slug: guide.slug,
			category: guide.category,
			provider: guide.provider,
			lastVerified: guide.lastVerified,
			...(section ? { section } : {}),
		}
	}

	if (!input.userId) {
		throw new McpCallerError(
			'Authentication required to access saved user entities.',
		)
	}

	if (ref.type === 'package') {
		const env = input.agent.getEnv()
		const loadedOwnRecord =
			(await getSavedPackageWithCommunityProvenanceById(env.APP_DB, {
				userId: input.userId,
				packageId: ref.id,
			})) ??
			(await getSavedPackageWithCommunityProvenanceByKodyId(env.APP_DB, {
				userId: input.userId,
				kodyId: ref.id,
			}))
		const [ownRecord] = loadedOwnRecord
			? await applySavedPackageForkListingAncestry({
					env,
					records: [loadedOwnRecord],
				})
			: [null]
		// Platform (built-in) packages stay discoverable without a fork so
		// agents can inspect and communityFork them. The caller's own copy
		// wins when both exist.
		const platformFallback = ownRecord
			? null
			: await findPlatformPackageByRef(env.APP_DB, { idOrKodyId: ref.id })
		const record = ownRecord ?? platformFallback?.record
		if (!record) {
			throw new McpCallerError('Saved package not found for this user.')
		}
		const loaded = await loadPackageSourceBySourceId({
			env,
			baseUrl: input.callerContext.baseUrl,
			userId: platformFallback?.ownerUserId ?? input.userId,
			sourceId: record.sourceId,
		})
		const packageAppOrigin = getPackageAppBaseUrl({ env })
		const ownerUsername = platformFallback?.platformScope ?? input.username
		return {
			type: 'package' as const,
			id: record.kodyId,
			title: record.name,
			description: record.description,
			record,
			manifest: loaded.manifest,
			files: loaded.files,
			baseUrl: input.callerContext.baseUrl,
			ownerUsername,
			platformScope: platformFallback?.platformScope ?? null,
			listingAhead: ownRecord?.listingAhead ?? null,
			hostedUrl:
				record.hasApp && ownerUsername
					? resolveHostedPackageAppUrl({
							packageAppBaseUrl: packageAppOrigin,
							appBaseUrl: input.callerContext.baseUrl,
							username: ownerUsername,
							kodyId: record.kodyId,
						})
					: null,
		}
	}

	if (ref.type === 'integration') {
		const joined = await getJoinedIntegration({
			env: input.agent.getEnv(),
			userId: input.userId,
			name: ref.id,
		})
		if (!joined) {
			throw new McpCallerError('Saved integration not found for this user.')
		}
		const config = toJoinedIntegrationConfig(joined)
		const relatedPackageSuggestions =
			await collectIntegrationPackageSuggestions({
				env: input.agent.getEnv(),
				baseUrl: input.callerContext.baseUrl,
				integration: config,
				packageRows: input.searchRows.packageRows,
			})
		return {
			type: 'integration' as const,
			id: config.name,
			title: config.name,
			description:
				joined.connection.description.trim() ||
				`Saved OAuth integration configuration (${config.flow} flow).`,
			config,
			...(relatedPackageSuggestions.length > 0
				? { relatedPackageSuggestions }
				: {}),
		}
	}

	const row = input.searchRows.userSecretRows.find(
		(secret) => secret.name === ref.id,
	)
	if (!row) {
		throw new McpCallerError('Secret not found for this user.')
	}
	return {
		type: 'secret' as const,
		id: row.name,
		title: row.name,
		description: row.description,
		row,
	}
}
