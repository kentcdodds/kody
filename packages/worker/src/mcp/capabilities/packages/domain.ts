import { defineDomain } from '../define-domain.ts'
import { capabilityDomainNames } from '../domain-metadata.ts'
import { deletePackageCapability } from './delete-package.ts'
import { getGitRemoteCapability } from './get-git-remote.ts'
import { getPackageCapability } from './get-package.ts'
import { listPackagesCapability } from './list-packages.ts'
import { listPackageSubscriptionsCapability } from './list-package-subscriptions.ts'
import { packageDebugGetRunCapability } from './package-debug-get-run.ts'
import { packageDebugListRunsCapability } from './package-debug-list-runs.ts'
import { publishExternalPushCapability } from './publish-external-push.ts'
import { savePackageCapability } from './save-package.ts'

export const packagesDomain = defineDomain({
	name: capabilityDomainNames.packages,
	description:
		'Saved packages are the only top-level persisted primitive. Coding agents with local git access can use package_get_git_remote for clone-edit-push workflows; tool-only agents can edit through repo sessions. Package metadata is rooted at package.json.',
	keywords: ['package', 'repo', 'package.json', 'exports', 'jobs', 'app'],
	capabilities: [
		savePackageCapability,
		getPackageCapability,
		getGitRemoteCapability,
		listPackagesCapability,
		listPackageSubscriptionsCapability,
		packageDebugListRunsCapability,
		packageDebugGetRunCapability,
		publishExternalPushCapability,
		deletePackageCapability,
	],
})
