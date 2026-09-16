import { listSecrets } from '#mcp/secrets/service.ts'
import {
	inspectSecretProviderPackageGrant,
	listAccountSecretProviderGrants,
	listBoundSecretProviders,
} from '#mcp/secrets/secret-providers/service.ts'
import { tryCanonicalizeProviderRef } from '#mcp/secrets/secret-providers/canonicalize.ts'
import { listSavedPackagesByUserId } from '#worker/package-registry/repo.ts'
import { type AccountSecretProvidersLoaderData } from '#universal/loader-data.ts'

export async function loadAccountSecretProvidersData(input: {
	env: Env
	userId: string
	email: string
	url: string
}): Promise<AccountSecretProvidersLoaderData> {
	const requestUrl = new URL(input.url)
	const [bindings, grants, packages, secrets] = await Promise.all([
		listBoundSecretProviders({
			env: input.env,
			userId: input.userId,
		}),
		listAccountSecretProviderGrants({
			env: input.env,
			userId: input.userId,
		}),
		listSavedPackagesByUserId(input.env.APP_DB, { userId: input.userId }),
		listSecrets({
			env: input.env,
			userId: input.userId,
			scope: 'user',
			storageContext: null,
		}),
	])
	const packagesById = new Map(packages.map((row) => [row.id, row]))
	const approval = await loadApprovalCard({
		env: input.env,
		userId: input.userId,
		searchParams: requestUrl.searchParams,
	})
	return {
		ok: true,
		email: input.email,
		bindings: bindings.map((binding) => ({
			provider: binding.providerId,
			packageId: binding.packageId,
			kodyId: packagesById.get(binding.packageId)?.kodyId ?? binding.packageId,
			doorSecretName: binding.doorSecretName,
			config: binding.config,
			updatedAt: binding.updatedAt,
		})),
		grants: grants.map((grant) => ({
			provider: grant.providerId,
			canonicalRef: grant.canonicalRef,
			packageId: grant.packageId,
			kodyId: packagesById.get(grant.packageId)?.kodyId ?? grant.packageId,
			createdAt: grant.createdAt,
		})),
		packages: packages.map((row) => ({
			id: row.id,
			kodyId: row.kodyId,
			name: row.name,
		})),
		doorSecrets: secrets.map((secret) => secret.name),
		approval,
	}
}

async function loadApprovalCard(input: {
	env: Env
	userId: string
	searchParams: URLSearchParams
}): Promise<AccountSecretProvidersLoaderData['approval']> {
	const provider = input.searchParams.get('provider')?.trim() ?? ''
	const ref = input.searchParams.get('ref')?.trim() ?? ''
	const packageId = input.searchParams.get('package_id')?.trim() ?? ''
	if (!provider || !ref || !packageId) return null
	const canonicalRef = tryCanonicalizeProviderRef(ref) ?? ref
	try {
		const state = await inspectSecretProviderPackageGrant({
			env: input.env,
			userId: input.userId,
			providerId: provider,
			ref: canonicalRef,
			packageId,
		})
		return {
			provider: state.providerId,
			canonicalRef: state.canonicalRef,
			packageId: state.savedPackage.id,
			kodyId: state.savedPackage.kodyId,
			alreadyGranted: state.alreadyGranted,
		}
	} catch {
		return {
			provider,
			canonicalRef,
			packageId,
			kodyId: input.searchParams.get('package')?.trim() || packageId,
			alreadyGranted: false,
			error: 'Unable to load this provider grant.',
		}
	}
}
