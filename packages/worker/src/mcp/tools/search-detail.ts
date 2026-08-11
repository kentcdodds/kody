import { resolveHostedPackageAppUrl } from '@kody-internal/shared/public-urls.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { type McpRegistrationAgent } from '#mcp/mcp-registration-agent.ts'
import {
	buildValueEntityId,
	describeValue,
	parseValueEntityId,
} from '#mcp/tools/search-entities.ts'
import { getValue } from '#mcp/values/service.ts'
import { getPackageAppBaseUrl } from '#worker/app-base-url.ts'
import {
	getJoinedIntegration,
	toJoinedIntegrationConfig,
} from '#worker/integrations/service.ts'
import {
	getSavedPackageById,
	getSavedPackageByKodyId,
} from '#worker/package-registry/repo.ts'
import { findPlatformPackageByRef } from '#worker/package-registry/platform-packages.ts'
import { loadPackageSourceBySourceId } from '#worker/package-registry/source.ts'

import { collectIntegrationPackageSuggestions } from './integration-package-suggestions.ts'
import { parseEntityRef } from './search-format.ts'
import { collectRelatedCapabilityOperations } from './search-related-capabilities.ts'
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
	if (ref.type === 'capability') {
		const spec = input.searchRows.registry.capabilitySpecs[ref.id]
		if (!spec) {
			throw new McpCallerError('Capability not found.')
		}
		const relatedOperations = collectRelatedCapabilityOperations({
			spec,
			registry: input.searchRows.registry,
		})
		return {
			type: 'capability' as const,
			id: ref.id,
			title: spec.name,
			description: spec.description,
			spec,
			...(relatedOperations.length > 0 ? { relatedOperations } : {}),
		}
	}

	if (!input.userId) {
		throw new McpCallerError(
			'Authentication required to access saved user entities.',
		)
	}

	if (ref.type === 'package') {
		const env = input.agent.getEnv()
		const ownRecord =
			(await getSavedPackageById(env.APP_DB, {
				userId: input.userId,
				packageId: ref.id,
			})) ??
			(await getSavedPackageByKodyId(env.APP_DB, {
				userId: input.userId,
				kodyId: ref.id,
			}))
		// Platform (built-in) packages resolve live for every caller, so
		// their detail is readable without a fork; the caller's own copy
		// wins, mirroring import resolution.
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

	if (ref.type === 'value') {
		const valueRef = parseValueEntityId(ref.id)
		const row =
			input.searchRows.userValueRows.find(
				(value) =>
					value.scope === valueRef.scope && value.name === valueRef.name,
			) ??
			(await getValue({
				env: input.agent.getEnv(),
				userId: input.userId,
				name: valueRef.name,
				scope: valueRef.scope,
				storageContext: {
					sessionId: input.callerContext.storageContext?.sessionId ?? null,
					appId: input.callerContext.storageContext?.appId ?? null,
				},
			}))
		if (!row) {
			throw new McpCallerError('Persisted value not found for this user.')
		}
		return {
			type: 'value' as const,
			id: buildValueEntityId(row),
			title: row.name,
			description: describeValue(row),
			row,
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
