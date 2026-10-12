import { type McpUserContext } from '@kody-internal/shared/chat.ts'
import { viewerCanReadSavedPackage } from '#worker/app/package-viewer-access.ts'
import {
	checkPermission,
	computeEffectivePermissions,
	packageResource,
} from '#worker/authorization/authorize.ts'
import { resolvePackagePageUrl } from '#worker/community/package-url.ts'
import { findPublicOwnerIdentityByHandle } from '#worker/identity/user-lookup.ts'
import { kodyPackageIdPattern } from '#worker/package-registry/types.ts'
import { loadOrgBindingForOrg } from '#worker/orgs/repo.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import { getEntitySourceByEntity } from '#worker/repo/entity-sources.ts'
import { getUserRepoByName } from '#worker/repo/user-repos.ts'
import { type GitAccessResourceKind } from '#worker/api-tokens/git-access-tokens.ts'
import {
	apiTokenScopeIncludes,
	type ApiTokenScope,
} from '#worker/api-tokens/scopes.ts'

export type ResolvedGitHttpTarget = {
	ownerHandle: string
	repoName: string
	resourceKind: GitAccessResourceKind
	resourceId: string
	resourceOrgId: string
	sourceId: string
	repoId: string
	/** When set, advertise/proxy only this commit (public package snapshot). */
	snapshotCommit: string | null
}

/**
 * Parse git-credential `path` / URL pathname into `@owner/name` leaf.
 * Accepts `owner/name.git`, `/@owner/name.git`, and smart-HTTP suffixes.
 */
export function parseGitCredentialRepoPath(path: string): {
	ownerHandle: string
	repoName: string
} | null {
	const trimmed = path.trim()
	const withoutQuery = trimmed.split('?')[0] ?? trimmed
	const parts = withoutQuery.split('/').filter(Boolean)
	if (parts.length < 2) return null
	const ownerPart = parts[0] ?? ''
	const repoPart = parts[1] ?? ''
	const ownerHandle = ownerPart.startsWith('@') ? ownerPart.slice(1) : ownerPart
	const repoSegment = decodeURIComponent(repoPart)
	if (!ownerHandle || !repoSegment.toLowerCase().endsWith('.git')) return null
	const repoName = repoSegment.slice(0, -'.git'.length)
	if (!repoName || !kodyPackageIdPattern.test(repoName)) return null
	return { ownerHandle, repoName }
}

/**
 * Resolve `@owner/name` to a package (preferred) or plain repo the caller may
 * read. Prefers a readable package when both a package and a repo share the
 * name (today's collision); otherwise the readable plain repo.
 */
export async function resolveReadableGitHttpTarget(input: {
	env: Env
	viewer: Pick<McpUserContext, 'userId' | 'username'>
	ownerHandle: string
	repoName: string
	scopes: ReadonlyArray<ApiTokenScope> | null
}): Promise<ResolvedGitHttpTarget | null> {
	if (!apiTokenScopesAllowPackageRead(input.scopes)) return null

	const identity = await findPublicOwnerIdentityByHandle({
		db: input.env.APP_DB,
		handle: input.ownerHandle,
	})
	if (!identity) return null

	const packagePage = await resolvePackagePageUrl({
		db: input.env.APP_DB,
		username: identity.handle,
		kodyId: input.repoName,
	})
	if (packagePage?.kind === 'package' && packagePage.savedPackage) {
		const canRead = await viewerCanReadSavedPackage({
			env: input.env,
			viewer: input.viewer,
			ownerId: packagePage.userId,
			packageId: packagePage.savedPackage.id,
		})
		if (canRead) {
			const withScopes = await viewerHasPackageReadWithScopes({
				env: input.env,
				viewer: input.viewer,
				ownerId: packagePage.userId,
				packageId: packagePage.savedPackage.id,
				scopes: input.scopes,
			})
			if (!withScopes) return null
			const source = await getEntitySourceByEntity(input.env.APP_DB, {
				userId: packagePage.userId,
				entityKind: 'package',
				entityId: packagePage.savedPackage.id,
			})
			if (!source?.repo_id) return null
			return {
				ownerHandle: identity.handle,
				repoName: packagePage.kodyId,
				resourceKind: 'package',
				resourceId: packagePage.savedPackage.id,
				resourceOrgId: packagePage.userId,
				sourceId: source.id,
				repoId: source.repo_id,
				snapshotCommit: null,
			}
		}
	}

	const userRepo = await getUserRepoByName(input.env.APP_DB, {
		userId: identity.ownerId,
		name: input.repoName,
	})
	if (!userRepo) return null
	const canReadRepo = await viewerCanReadUserRepo({
		env: input.env,
		viewer: input.viewer,
		ownerId: identity.ownerId,
		scopes: input.scopes,
	})
	if (!canReadRepo) return null
	const source = await getEntitySourceByEntity(input.env.APP_DB, {
		userId: identity.ownerId,
		entityKind: 'repo',
		entityId: userRepo.id,
	})
	if (!source?.repo_id) return null
	return {
		ownerHandle: identity.handle,
		repoName: userRepo.name,
		resourceKind: 'repo',
		resourceId: userRepo.id,
		resourceOrgId: identity.ownerId,
		sourceId: source.id,
		repoId: source.repo_id,
		snapshotCommit: null,
	}
}

function apiTokenScopesAllowPackageRead(
	scopes: ReadonlyArray<ApiTokenScope> | null,
) {
	if (scopes === null) return true
	return apiTokenScopeIncludes(scopes, 'package:read')
}

async function viewerHasPackageReadWithScopes(input: {
	env: Env
	viewer: Pick<McpUserContext, 'userId' | 'username'>
	ownerId: string
	packageId: string
	scopes: ReadonlyArray<ApiTokenScope> | null
}) {
	if (input.scopes === null) return true
	const binding = await loadOrgBindingForOrg(
		input.env.APP_DB,
		input.viewer.userId,
		input.ownerId,
	)
	if (!binding) return false
	const access = await computeEffectivePermissions({
		env: input.env,
		request: deriveRequestContext({
			user: input.viewer,
			source: { kind: 'api-token', tokenId: 'git-credential' },
			orgBinding: binding,
			scopes: input.scopes,
		}),
	})
	return checkPermission(
		access,
		'package:read',
		packageResource({ id: input.packageId, userId: input.ownerId }),
	).allowed
}

async function viewerCanReadUserRepo(input: {
	env: Env
	viewer: Pick<McpUserContext, 'userId' | 'username'>
	ownerId: string
	scopes: ReadonlyArray<ApiTokenScope> | null
}) {
	const binding = await loadOrgBindingForOrg(
		input.env.APP_DB,
		input.viewer.userId,
		input.ownerId,
	)
	if (!binding) return false
	const access = await computeEffectivePermissions({
		env: input.env,
		request: deriveRequestContext({
			user: input.viewer,
			source: { kind: 'api-token', tokenId: 'git-credential' },
			orgBinding: binding,
			scopes: input.scopes,
		}),
	})
	return checkPermission(access, 'package:read').allowed
}
