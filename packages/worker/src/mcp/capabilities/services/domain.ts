import { defineDomain } from '../define-domain.ts'
import { capabilityDomainNames } from '../domain-metadata.ts'
import { serviceGetCapability } from './service-get.ts'
import { serviceListCapability } from './service-list.ts'
import { serviceStartCapability } from './service-start.ts'
import { serviceStopCapability } from './service-stop.ts'

export const servicesDomain = defineDomain({
	name: capabilityDomainNames.services,
	description:
		'Package service capabilities for inspecting and controlling long-lived package-owned runtimes.',
	keywords: ['service', 'package service', 'runtime', 'background', 'gateway'],
	capabilities: [
		serviceListCapability,
		serviceGetCapability,
		serviceStartCapability,
		serviceStopCapability,
	],
})
