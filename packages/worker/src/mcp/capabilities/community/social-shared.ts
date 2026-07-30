import { z } from 'zod'
import { buildUserAvatarUrl } from '#worker/community/public-urls.ts'
import {
	type CommunityProfileRecord,
	type PublicProfilePackage,
} from '#worker/community/types.ts'
import { communityActivityItemSchema } from './shared.ts'

export const communityProfileVisibilitySchema = z.enum(['public', 'private'])

export const communityProfileOutputSchema = z.object({
	username: z.string(),
	display_name: z.string(),
	bio: z.string().nullable(),
	avatar_url: z.string().nullable(),
	visibility: communityProfileVisibilitySchema,
	joined_at: z.string(),
	follower_count: z.number().int().nonnegative(),
	following_count: z.number().int().nonnegative(),
	public_package_count: z.number().int().nonnegative(),
	listing_count: z.number().int().nonnegative(),
})

export const communityProfilePackageSchema = z.object({
	package_id: z.string().optional(),
	name: z.string(),
	kody_id: z.string(),
	description: z.string(),
	tags: z.array(z.string()),
	updated_at: z.string(),
	community_listing_id: z.string().nullable(),
})

export const communityProfileGetOutputSchema = z.object({
	user_found: z.boolean(),
	profile: communityProfileOutputSchema.nullable(),
	packages: z.array(communityProfilePackageSchema),
	recent_activity: z.array(communityActivityItemSchema),
})

export function toCommunityProfileOutput(
	profile: CommunityProfileRecord,
	baseUrl: string,
) {
	const avatarPath = buildUserAvatarUrl({
		username: profile.username,
		avatarKey: profile.avatarKey,
	})
	return {
		username: profile.username,
		display_name: profile.displayName,
		bio: profile.bio,
		avatar_url: avatarPath ? `${baseUrl}${avatarPath}` : null,
		visibility: profile.visibility,
		joined_at: profile.joinedAt,
		follower_count: profile.followerCount,
		following_count: profile.followingCount,
		public_package_count: profile.publicPackageCount,
		listing_count: profile.listingCount,
	}
}

export function toCommunityProfilePackageOutput(
	pkg: PublicProfilePackage,
	options: { includePackageId: boolean },
) {
	const output: {
		package_id?: string
		name: string
		kody_id: string
		description: string
		tags: Array<string>
		updated_at: string
		community_listing_id: string | null
	} = {
		name: pkg.name,
		kody_id: pkg.kodyId,
		description: pkg.description,
		tags: pkg.tags,
		updated_at: pkg.updatedAt,
		community_listing_id: pkg.communityListingId,
	}
	if (options.includePackageId) {
		output.package_id = pkg.packageId
	}
	return output
}
