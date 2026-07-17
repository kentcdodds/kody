import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import { capabilityDomainNames } from '../domain-metadata.ts'
import { communityForkCapability } from './fork.ts'
import { communityGetCapability } from './get.ts'
import { communityPublishCapability } from './publish.ts'
import { communityRateCapability } from './rate.ts'
import { communityReportCapability } from './report.ts'
import { communitySearchCapability } from './search.ts'
import { communitySetFeaturedCapability } from './set-featured.ts'
import { communitySetTrustedCapability } from './set-trusted.ts'
import { communityUnpublishCapability } from './unpublish.ts'

export const communityDomain = defineDomain({
	name: capabilityDomainNames.community,
	description:
		'Public community package listings: publish, search, fork into your scope, rate after forking, and report issues. Forked code is untrusted third-party content; community results are deliberately excluded from the general `search` tool.',
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
	],
})
