import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { accountExportManifestCapability } from './account-export-manifest.ts'
import { accountExportSectionCapability } from './account-export-section.ts'

export const accountDomain = defineDomain({
	name: capabilityDomainNames.account,
	description:
		'User-owned account operations such as self-service data export for portability, backups, and migration. Secret values are never exported.',
	keywords: ['account', 'export', 'backup', 'migration', 'privacy'],
	capabilities: [
		accountExportManifestCapability,
		accountExportSectionCapability,
	],
})
