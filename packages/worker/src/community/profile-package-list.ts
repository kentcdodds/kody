import { type ProfilePackageFilters } from '#universal/community-public-types.ts'
import { listingNeedsRepublishSql } from './listing-needs-republish.ts'
import { listPublicProfilePackages as listPublicProfilePackagesFromDb } from './profile-repo.ts'
import { type PublicProfilePackage } from './types.ts'

const activeListingExistsSql = `EXISTS (
	SELECT 1 FROM community_listings AS cl
	WHERE cl.owner_user_id = saved_packages.user_id
		AND cl.status = 'active'
		AND cl.package_id = saved_packages.id
)`

function profilePackageFilterWhereSql(
	filters: ProfilePackageFilters,
): Array<string> {
	const conditions: Array<string> = []
	switch (filters.visibility) {
		case 'all':
			break
		case 'public':
			conditions.push('is_private = 0')
			break
		case 'private':
			conditions.push('is_private = 1')
			break
		default: {
			const exhaustive: never = filters.visibility
			throw new Error(`Unhandled profile visibility filter: ${exhaustive}`)
		}
	}
	switch (filters.hidden) {
		case 'all':
			break
		case 'yes':
			conditions.push('hidden = 1')
			break
		case 'no':
			conditions.push('hidden = 0')
			break
		default: {
			const exhaustive: never = filters.hidden
			throw new Error(`Unhandled profile hidden filter: ${exhaustive}`)
		}
	}
	switch (filters.listing) {
		case 'all':
			break
		case 'published':
			conditions.push(activeListingExistsSql)
			break
		case 'unpublished':
			conditions.push(`NOT ${activeListingExistsSql}`)
			break
		case 'ahead':
			conditions.push(listingNeedsRepublishSql)
			break
		default: {
			const exhaustive: never = filters.listing
			throw new Error(`Unhandled profile listing filter: ${exhaustive}`)
		}
	}
	return conditions
}

/**
 * Owner/guest GET filters for `/@username`. Kept out of `profile-service` so
 * the runtime worker's MCP profile-get path does not load this SQL.
 */
export async function listPublicProfilePackages(input: {
	env: Env
	ownerStableUserId: string
	query?: string
	limit: number
	includePrivate?: boolean
	filters?: ProfilePackageFilters
}): Promise<Array<PublicProfilePackage>> {
	return await listPublicProfilePackagesFromDb(input.env.APP_DB, {
		ownerStableUserId: input.ownerStableUserId,
		query: input.query,
		limit: input.limit,
		includePrivate: input.includePrivate,
		additionalWhereSql: input.filters
			? profilePackageFilterWhereSql(input.filters)
			: undefined,
	})
}
