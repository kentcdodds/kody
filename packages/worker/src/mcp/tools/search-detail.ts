import { buildPackageAppUrl } from '@kody-internal/shared/public-urls.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import {
	parseIntegrationConfig,
	parseIntegrationJson,
	parseIntegrationValueName,
} from '#mcp/capabilities/integrations/integration-shared.ts'
import { type McpRegistrationAgent } from '#mcp/mcp-registration-agent.ts'
import {
	buildValueEntityId,
	describeValue,
	parseValueEntityId,
} from '#mcp/tools/search-entities.ts'
import { getValue } from '#mcp/values/service.ts'
import { type ValueMetadata } from '#mcp/values/types.ts'
import {
	getSavedPackageById,
	getSavedPackageByKodyId,
} from '#worker/package-registry/repo.ts'
import { loadPackageSourceBySourceId } from '#worker/package-registry/source.ts'

import { collectIntegrationPackageSuggestions } from './integration-package-suggestions.ts'
import { parseEntityRef } from './search-format.ts'
import { collectRelatedCapabilityOperations } from './search-related-capabilities.ts'
import { type SearchRowsAndRegistry } from './search-types.ts'

function findIntegrationDetail(
	rows: Array<ValueMetadata>,
	integrationName: string,
) {
	for (const row of rows) {
		if (parseIntegrationValueName(row.name) !== integrationName) continue
		const config = parseIntegrationConfig(
			parseIntegrationJson(row.value),
			integrationName,
		)
		if (!config) continue
		return { row, config }
	}
	return null
}

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
		const record =
			(await getSavedPackageById(input.agent.getEnv().APP_DB, {
				userId: input.userId,
				packageId: ref.id,
			})) ??
			(await getSavedPackageByKodyId(input.agent.getEnv().APP_DB, {
				userId: input.userId,
				kodyId: ref.id,
			}))
		if (!record) {
			throw new McpCallerError('Saved package not found for this user.')
		}
		const loaded = await loadPackageSourceBySourceId({
			env: input.agent.getEnv(),
			baseUrl: input.callerContext.baseUrl,
			userId: input.userId,
			sourceId: record.sourceId,
		})
		return {
			type: 'package' as const,
			id: record.kodyId,
			title: record.name,
			description: record.description,
			record,
			manifest: loaded.manifest,
			files: loaded.files,
			baseUrl: input.callerContext.baseUrl,
			ownerUsername: input.username,
			hostedUrl:
				record.hasApp && input.username
					? buildPackageAppUrl({
							origin: input.callerContext.baseUrl,
							username: input.username,
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
		const integration = findIntegrationDetail(
			input.searchRows.userValueRows,
			ref.id,
		)
		if (!integration) {
			throw new McpCallerError('Saved integration not found for this user.')
		}
		const relatedPackageSuggestions =
			await collectIntegrationPackageSuggestions({
				env: input.agent.getEnv(),
				baseUrl: input.callerContext.baseUrl,
				integration: integration.config,
				packageRows: input.searchRows.packageRows,
			})
		return {
			type: 'integration' as const,
			id: integration.config.name,
			title: integration.config.name,
			description:
				integration.row.description.trim() ||
				`Saved OAuth integration configuration (${integration.config.flow} flow).`,
			row: integration.row,
			config: integration.config,
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
