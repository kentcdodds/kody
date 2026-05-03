import { defineDomain } from '../define-domain.ts'
import { capabilityDomainNames } from '../domain-metadata.ts'
import { deletePackageCapability } from './delete-package.ts'
import { getPackageCapability } from './get-package.ts'
import { listPackagesCapability } from './list-packages.ts'
import { listPackageSubscriptionsCapability } from './list-package-subscriptions.ts'
import { packageCheckCapability } from './package-check.ts'
import { packagePublishCapability } from './package-publish.ts'
import { packageShellExecCapability } from './package-shell-exec.ts'
import { packageShellOpenCapability } from './package-shell-open.ts'
import { savePackageCapability } from './save-package.ts'

export const packagesDomain = defineDomain({
	name: capabilityDomainNames.packages,
	description:
		'Saved packages are repo-backed modules authored through trusted shell workbenches, then checked and published through Kody platform gates.',
	keywords: [
		'package',
		'shell',
		'sandbox',
		'repo',
		'package.json',
		'exports',
		'jobs',
		'app',
	],
	capabilities: [
		savePackageCapability,
		getPackageCapability,
		listPackagesCapability,
		listPackageSubscriptionsCapability,
		packageShellOpenCapability,
		packageShellExecCapability,
		packageCheckCapability,
		packagePublishCapability,
		deletePackageCapability,
	],
})
