import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { filterCapabilityRegistryMcpServersForCaller } from '#mcp/capabilities/access-control.ts'
import { getCapabilityRegistryForContext } from '#mcp/capabilities/registry.ts'
import { listUserSecretsForSearch } from '#mcp/secrets/service.ts'
import { type SecretSearchRow } from '#mcp/secrets/types.ts'
import { type ValueMetadata } from '#mcp/values/types.ts'
import { listJoinedIntegrations } from '#worker/integrations/service.ts'
import { type JoinedIntegration } from '#worker/integrations/types.ts'
import { listVisibleEnabledMcpServerRefsCached } from '#worker/mcp-client/settings-service.ts'
import { applySavedPackageForkListingAncestry } from '#worker/community/fork-listing-relation.ts'
import { listSavedPackagesWithCommunityProvenanceByUserId } from '#worker/package-registry/repo.ts'
import {
	canSeeResource,
	computeEffectivePermissions,
	packageResource,
	runWithRequestPermissions,
} from '#worker/authorization/authorize.ts'

import { buildSavedPackageSearchRows } from './search-package-rows.ts'
import {
	type LoadedPackageRows,
	type OptionalSearchRowsResult,
} from './search-types.ts'

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
	const { request } = input.callerContext
	const access = request
		? await computeEffectivePermissions({ env: input.env, request })
		: null
	const reveal = (pkg: { id: string; userId: string }) =>
		!access || canSeeResource(access, packageResource(pkg))
	return await runWithRequestPermissions(
		{ env: input.env, request },
		async () => {
			const [runtimeRegistry, optionalRows] = await Promise.all([
				getCapabilityRegistryForContext({
					env: input.env,
					callerContext: input.callerContext,
				}),
				loadOptionalSearchRows({
					userId: input.userId,
					loadPackages: async () => {
						if (!input.userId) {
							return { rows: [], warnings: [] }
						}
						// Packages are keyed by the bound org, not the acting person.
						const ownerId = request?.org.id ?? input.userId
						const savedPackages = await applySavedPackageForkListingAncestry({
							env: input.env,
							records: await listSavedPackagesWithCommunityProvenanceByUserId(
								input.env.APP_DB,
								{ userId: ownerId },
							),
						})
						return await buildSavedPackageSearchRows({
							env: input.env,
							baseUrl: input.callerContext.baseUrl,
							userId: ownerId,
							records: savedPackages.filter(
								(pkg) =>
									(input.includeHiddenPackages ? true : !pkg.hidden) &&
									reveal(pkg),
							),
						})
					},
					loadUserSecrets: async () => {
						// Connection profiles grant packages only, never secrets.
						if (access?.profileGrants) return []
						const userId = input.userId
						if (!userId) return []
						return listUserSecretsForSearch({
							env: input.env,
							userId,
						})
					},
					loadUserValues: async () => [],
					loadUserIntegrations: async () => {
						if (access?.profileGrants) return []
						const userId = input.userId
						if (!userId) return []
						return listJoinedIntegrations({
							env: input.env,
							userId,
						})
					},
				}),
			])
			// Runtime registry keeps package-locked MCP servers for call-time grants;
			// search must still hide servers the caller cannot use (execute / other pkgs).
			const registry = input.userId
				? filterCapabilityRegistryMcpServersForCaller(
						runtimeRegistry,
						new Set(
							(
								await listVisibleEnabledMcpServerRefsCached({
									env: input.env,
									userId: input.userId,
									packageId: input.callerContext.storageContext?.packageId,
								}).catch(() => [])
							).map((ref) => ref.serverId),
						),
					)
				: runtimeRegistry
			return {
				registry,
				...optionalRows,
			}
		},
	)
}
