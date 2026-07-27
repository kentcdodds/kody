import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { normalizeRemoteConnectorRefs } from '@kody-internal/shared/remote-connectors.ts'
import { getCapabilityRegistryForContext } from '#mcp/capabilities/registry.ts'
import { listUserSecretsForSearch } from '#mcp/secrets/service.ts'
import { type SecretSearchRow } from '#mcp/secrets/types.ts'
import { listValues } from '#mcp/values/service.ts'
import { type ValueMetadata } from '#mcp/values/types.ts'
import { listJoinedIntegrations } from '#worker/integrations/service.ts'
import { type JoinedIntegration } from '#worker/integrations/types.ts'
import { listSavedPackagesByUserId } from '#worker/package-registry/repo.ts'
import {
	getRemoteConnectorStatus,
	type RemoteConnectorStatus,
} from '#worker/remote-connector/status.ts'

import { buildSavedPackageSearchRows } from './search-package-rows.ts'
import {
	type LoadedPackageRows,
	type OptionalSearchRowsResult,
} from './search-types.ts'

function shouldIncludeRemoteConnectorStatus(status: RemoteConnectorStatus) {
	return status.state !== 'connected' || status.toolCount === 0
}

export function serializeRemoteConnectorStatus(status: RemoteConnectorStatus): {
	connectorId: string
	state: string
	connected: boolean
	toolCount: number
} {
	return {
		connectorId: status.connectorId ?? 'unknown',
		state: status.state,
		connected: status.connected,
		toolCount: status.toolCount,
	}
}

export async function loadDownRemoteConnectorStatuses(input: {
	env: Env
	callerContext: Pick<McpCallerContext, 'remoteConnectors' | 'user'>
}): Promise<Array<RemoteConnectorStatus>> {
	const refs = normalizeRemoteConnectorRefs(input.callerContext)
	const userId = input.callerContext.user?.userId ?? null
	if (refs.length === 0 || !userId) {
		return []
	}
	const statuses = await Promise.all(
		refs.map((ref) =>
			getRemoteConnectorStatus({ env: input.env, userId, ref }),
		),
	)
	return statuses.filter(shouldIncludeRemoteConnectorStatus)
}

export async function loadOptionalSearchRows(input: {
	userId: string | null
	loadPackages: () => Promise<LoadedPackageRows>
	loadUserSecrets: () => Promise<Array<SecretSearchRow>>
	loadUserValues: () => Promise<Array<ValueMetadata>>
	loadUserIntegrations: () => Promise<Array<JoinedIntegration>>
}): Promise<OptionalSearchRowsResult> {
	if (!input.userId) {
		return {
			packageRows: [],
			userSecretRows: [],
			userValueRows: [],
			userIntegrationRows: [],
			warnings: [],
		}
	}

	const [
		loadedPackageRows,
		userSecretRows,
		userValueRows,
		userIntegrationRows,
	] = await Promise.all([
		input.loadPackages(),
		input.loadUserSecrets(),
		input.loadUserValues(),
		input.loadUserIntegrations(),
	])
	const packageRows = Array.isArray(loadedPackageRows)
		? loadedPackageRows
		: loadedPackageRows.rows

	return {
		packageRows,
		userSecretRows,
		userValueRows,
		userIntegrationRows,
		warnings: [],
	}
}

export async function loadSearchRowsAndRegistry(input: {
	env: Env
	callerContext: McpCallerContext
	userId: string | null
	includeHiddenPackages?: boolean
}) {
	const [registry, optionalRows] = await Promise.all([
		getCapabilityRegistryForContext({
			env: input.env,
			callerContext: input.callerContext,
		}),
		loadOptionalSearchRows({
			userId: input.userId,
			loadPackages: async () => {
				const savedPackages = await listSavedPackagesByUserId(
					input.env.APP_DB,
					{
						userId: input.userId!,
					},
				)
				const packageRows = await buildSavedPackageSearchRows({
					env: input.env,
					baseUrl: input.callerContext.baseUrl,
					userId: input.userId!,
					records: savedPackages.filter((pkg) =>
						input.includeHiddenPackages ? true : !pkg.hidden,
					),
				})
				return packageRows
			},
			loadUserSecrets: () =>
				listUserSecretsForSearch({
					env: input.env,
					userId: input.userId!,
				}),
			loadUserValues: () =>
				listValues({
					env: input.env,
					userId: input.userId!,
					storageContext: {
						sessionId: input.callerContext.storageContext?.sessionId ?? null,
						appId: input.callerContext.storageContext?.appId ?? null,
					},
				}),
			loadUserIntegrations: () =>
				listJoinedIntegrations({
					env: input.env,
					userId: input.userId!,
				}),
		}),
	])
	return {
		registry,
		...optionalRows,
	}
}
