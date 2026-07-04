import { getAppBaseUrl } from '#app/app-base-url.ts'
import { type AccountPackageInvocationTokensLoaderData } from '#app/loader-data.ts'
import { type readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	listPackageInvocationTokensByUserId,
	type PackageInvocationTokenRecord,
} from '#worker/package-invocations/repo.ts'
import { listSavedPackagesByUserId } from '#worker/package-registry/repo.ts'

type AuthenticatedUser = NonNullable<
	Awaited<ReturnType<typeof readAuthenticatedAppUser>>
>

type SavedPackageSummary = {
	id: string
	kodyId: string
	name: string
}

const accountPackageInvocationTokensBasePath =
	'/account/package-invocation-tokens'

export function readPackageInvocationTokenSelectedId(
	requestUrl: string,
	pathTokenId?: string,
) {
	if (pathTokenId?.trim()) return pathTokenId.trim()
	const url = new URL(requestUrl, 'http://localhost')
	if (url.pathname === `${accountPackageInvocationTokensBasePath}/new`) {
		return null
	}
	const detailPrefix = `${accountPackageInvocationTokensBasePath}/`
	if (!url.pathname.startsWith(detailPrefix)) return null
	const tokenId = decodeURIComponent(url.pathname.slice(detailPrefix.length))
	return tokenId || null
}

export async function loadAccountPackageInvocationTokensData(input: {
	env: Env
	request: Request
	user: AuthenticatedUser
	pathTokenId?: string
	savedPackages?: Array<SavedPackageSummary>
}): Promise<AccountPackageInvocationTokensLoaderData> {
	const userId = input.user.mcpUser.userId
	const [savedPackages, tokens] = await Promise.all([
		input.savedPackages ??
			listSavedPackagesByUserId(input.env.APP_DB, { userId }),
		listPackageInvocationTokensByUserId({
			db: input.env.APP_DB,
			userId,
		}),
	])
	const selectedTokenId = readPackageInvocationTokenSelectedId(
		input.request.url,
		input.pathTokenId,
	)
	return {
		ok: true,
		email: input.user.email,
		username: input.user.username,
		invocationUrlOrigin: getAppBaseUrl({
			env: input.env,
			requestUrl: input.request.url,
		}),
		packages: savedPackages.map((savedPackage) => ({
			id: savedPackage.id,
			kodyId: savedPackage.kodyId,
			name: savedPackage.name,
		})),
		tokens: tokens.map(toListItem),
		...(selectedTokenId ? { selectedTokenId } : {}),
	}
}

function toListItem(
	token: PackageInvocationTokenRecord,
): AccountPackageInvocationTokensLoaderData['tokens'][number] {
	return {
		id: token.id,
		name: token.name,
		packageIds: token.packageIds,
		packageKodyIds: token.packageKodyIds,
		exportNames: token.exportNames,
		sources: token.sources,
		createdAt: token.created_at,
		updatedAt: token.updated_at,
		lastUsedAt: token.last_used_at,
		revokedAt: token.revoked_at,
	}
}
