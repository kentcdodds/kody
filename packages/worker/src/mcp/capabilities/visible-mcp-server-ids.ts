import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { resolveCallerSecretAuthority } from '#mcp/secrets/secret-authority.ts'
import { listVisibleEnabledMcpServerRefsCached } from '#worker/mcp-client/settings-service.ts'

/**
 * Server ids the caller may discover (search / metaList / instructions).
 * Uses validated secret-authority packageId so a stamped package export
 * imported into execute sees its approved locked servers; bare execute stays
 * null and only sees unlocked servers.
 */
export async function listVisibleMcpServerIdsForCaller(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
	callerContext: McpCallerContext
}): Promise<ReadonlySet<string>> {
	const { authorityPackageId } = resolveCallerSecretAuthority({
		storageContext: input.callerContext.storageContext,
	})
	try {
		const refs = await listVisibleEnabledMcpServerRefsCached({
			env: input.env,
			userId: input.userId,
			packageId: authorityPackageId,
		})
		return new Set(refs.map((ref) => ref.serverId))
	} catch {
		return new Set()
	}
}
