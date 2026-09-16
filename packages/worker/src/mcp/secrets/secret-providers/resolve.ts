import { type StorageContext } from '#mcp/storage.ts'
import { invokeSealedSecretProvider } from './sealed-invoke.ts'
import { resolveProviderSecret } from './service.ts'

/**
 * Fetch-boundary entry. Ordinary execute and package invoke never call this;
 * they cannot observe `{ value }`.
 */
export async function resolveProviderSecretForFetch(input: {
	env: Env
	baseUrl: string
	userId: string
	provider: string
	ref: string
	storageContext?: StorageContext | null
	authorityPackageId?: string | null
}) {
	return await resolveProviderSecret({
		...input,
		invokeProvider: invokeSealedSecretProvider,
	})
}
