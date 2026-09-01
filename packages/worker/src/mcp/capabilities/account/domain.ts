import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { accountExportManifestCapability } from './account-export-manifest.ts'
import { accountExportSectionCapability } from './account-export-section.ts'
import { usageGetCapability } from './usage-get.ts'
import { waitingSummaryCapability } from './waiting-summary.ts'

export const accountDomain = defineDomain({
	name: capabilityDomainNames.account,
	description:
		'Self-service account export, backup, migration, entitlement usage, and the current-state waiting queue (secrets never exported).',
	keywords: [
		'account',
		'export',
		'backup',
		'migration',
		'privacy',
		'usage',
		'quota',
		'waiting',
		'approvals',
		'blockers',
	],
	capabilities: [
		accountExportManifestCapability,
		accountExportSectionCapability,
		usageGetCapability,
		waitingSummaryCapability,
	],
})
