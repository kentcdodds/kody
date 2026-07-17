import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import { capabilityDomainNames } from '../domain-metadata.ts'
import { deletePackageCapability } from './delete-package.ts'
import { getGitRemoteCapability } from './get-git-remote.ts'
import { getPackageCapability } from './get-package.ts'
import { listPackagesCapability } from './list-packages.ts'
import { listPackageSubscriptionsCapability } from './list-package-subscriptions.ts'
import { packageDebugGetRunCapability } from './package-debug-get-run.ts'
import { packageDebugListRunsCapability } from './package-debug-list-runs.ts'
import { packageInvocationTokenGetCapability } from './package-invocation-token-get.ts'
import { packageInvocationTokenListCapability } from './package-invocation-token-list.ts'
import { packageUpdateCapability } from './package-update.ts'
import { publishExternalPushCapability } from './publish-external-push.ts'
import { savePackageCapability } from './save-package.ts'

export const packagesDomain = defineDomain({
	name: capabilityDomainNames.packages,
	description:
		'Saved packages, the only top-level persisted primitive: repo-backed code rooted at package.json whose metadata declares exports, jobs, apps, services, and event subscriptions.',
	keywords: [
		'package',
		'repo',
		'package.json',
		'exports',
		'jobs',
		'app',
		'services',
		'subscriptions',
		'event handlers',
	],
	capabilities: [
		savePackageCapability,
		getPackageCapability,
		getGitRemoteCapability,
		listPackagesCapability,
		listPackageSubscriptionsCapability,
		packageUpdateCapability,
		packageInvocationTokenListCapability,
		packageInvocationTokenGetCapability,
		packageDebugListRunsCapability,
		packageDebugGetRunCapability,
		publishExternalPushCapability,
		deletePackageCapability,
	],
})
