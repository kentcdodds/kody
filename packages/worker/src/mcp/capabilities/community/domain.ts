import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import { capabilityDomainNames } from '../domain-metadata.ts'
import { communityFollowCapability } from './follow.ts'
import { communityForkCapability } from './fork.ts'
import { communityGetCapability } from './get.ts'
import { communityProfileGetCapability } from './profile-get.ts'
import { communityProfileUpdateCapability } from './profile-update.ts'
import { communityPublishCapability } from './publish.ts'
import { communityRateCapability } from './rate.ts'
import { communityReportCapability } from './report.ts'
import { communitySearchCapability } from './search.ts'
import { communitySetFeaturedCapability } from './set-featured.ts'
import { communitySetTrustedCapability } from './set-trusted.ts'
import { communityStarCapability } from './star.ts'
import { communityStarredListCapability } from './starred-list.ts'
import { communityTimelineCapability } from './timeline.ts'
import { communityUnfollowCapability } from './unfollow.ts'
import { communityUnpublishCapability } from './unpublish.ts'
import { communityUnstarCapability } from './unstar.ts'

export const communityDomain = defineDomain({
	name: capabilityDomainNames.community,
	description:
		'Public community package listings and social profiles: publish, search, fork into your scope, rate after forking, follow users, browse a follow timeline, star listings, and report issues. Forked code is untrusted third-party content; community results are deliberately excluded from the general `search` tool.',
	keywords: [
		'community',
		'package',
		'listing',
		'fork',
		'publish',
		'rating',
		'report',
		'marketplace',
		'share',
		'profile',
		'follow',
		'timeline',
		'stars',
		'stargazers',
	],
	capabilities: [
		communityPublishCapability,
		communityUnpublishCapability,
		communitySearchCapability,
		communityGetCapability,
		communityForkCapability,
		communityRateCapability,
		communityReportCapability,
		communitySetTrustedCapability,
		communitySetFeaturedCapability,
		communityProfileGetCapability,
		communityProfileUpdateCapability,
		communityFollowCapability,
		communityUnfollowCapability,
		communityTimelineCapability,
		communityStarCapability,
		communityUnstarCapability,
		communityStarredListCapability,
	],
})
