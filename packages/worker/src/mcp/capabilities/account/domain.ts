import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { accountExportManifestCapability } from './account-export-manifest.ts'
import { accountExportSectionCapability } from './account-export-section.ts'
import { usageGetCapability } from './usage-get.ts'

export const accountDomain = defineDomain({
	name: capabilityDomainNames.account,
	description:
		'Self-service account export, backup, migration, and entitlement usage (secrets never exported).',
	keywords: [
		'account',
		'export',
		'backup',
		'migration',
		'privacy',
		'usage',
		'quota',
	],
	capabilities: [
		accountExportManifestCapability,
		accountExportSectionCapability,
		usageGetCapability,
	],
})
