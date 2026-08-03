import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { accountExportManifestCapability } from './account-export-manifest.ts'
import { accountExportSectionCapability } from './account-export-section.ts'

export const accountDomain = defineDomain({
	name: capabilityDomainNames.account,
	description:
		'Self-service account export, backup, and migration (secrets never exported).',
	keywords: ['account', 'export', 'backup', 'migration', 'privacy'],
	capabilities: [
		accountExportManifestCapability,
		accountExportSectionCapability,
	],
})
