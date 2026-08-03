import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { storageExportCapability } from './storage-export.ts'
import { storageQueryCapability } from './storage-query.ts'

export const storageDomain = defineDomain({
	name: capabilityDomainNames.storage,
	description: 'Inspect and query durable storage buckets by storage id.',
	keywords: ['storage', 'sqlite', 'query', 'export', 'introspection'],
	capabilities: [storageExportCapability, storageQueryCapability],
})
