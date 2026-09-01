import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import { capabilityDomainNames } from '../domain-metadata.ts'
import { communityForkAdoptCapability } from './adopt.ts'
import { communityForkCapability } from './fork.ts'
import { communityGetCapability } from './get.ts'
import { communityProfileGetCapability } from './profile-get.ts'
import { communityProfileUpdateCapability } from './profile-update.ts'
import { communityPublishCapability } from './publish.ts'
import { communityRateCapability } from './rate.ts'
import { communityReportCapability } from './report.ts'
import { communitySearchCapability } from './search.ts'
import { communitySetFeaturedCapability } from './set-featured.ts'
import { communityUnpublishCapability } from './unpublish.ts'

export const communityDomain = defineDomain({
	name: capabilityDomainNames.community,
	description:
		'Public package listings and user catalogs (excluded from general search).',
	keywords: [
		'community',
		'package',
		'listing',
		'fork',
		'adopt',
		'rating',
		'report',
		'marketplace',
		'share',
		'profile',
	],
	capabilities: [
		communityPublishCapability,
		communityUnpublishCapability,
		communitySearchCapability,
		communityGetCapability,
		communityForkCapability,
		communityForkAdoptCapability,
		communityRateCapability,
		communityReportCapability,
		communitySetFeaturedCapability,
		communityProfileGetCapability,
		communityProfileUpdateCapability,
	],
})
