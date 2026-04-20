import { defineDomain } from '../define-domain.ts'
import { capabilityDomainNames } from '../domain-metadata.ts'
import { deletePackageCapability } from './delete-package.ts'
import { getPackageCapability } from './get-package.ts'
import { listPackagesCapability } from './list-packages.ts'
import { savePackageCapability } from './save-package.ts'

export const packagesDomain = defineDomain({
	name: capabilityDomainNames.packages,
	description:
		'Saved packages are the only top-level persisted primitive. A package owns repo-backed source, package-scoped config, optional package storage, optional package-owned jobs, and optional app surfaces rooted at package.json.',
	keywords: ['package', 'repo', 'package.json', 'exports', 'jobs', 'app'],
	capabilities: [
		savePackageCapability,
		getPackageCapability,
		listPackagesCapability,
		deletePackageCapability,
	],
})
