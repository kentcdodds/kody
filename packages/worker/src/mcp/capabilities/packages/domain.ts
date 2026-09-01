import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import { capabilityDomainNames } from '../domain-metadata.ts'
import { deletePackageCapability } from './delete-package.ts'
import { getGitRemoteCapability } from './get-git-remote.ts'
import { getPackageCapability } from './get-package.ts'
import { listPackagesCapability } from './list-packages.ts'
import { listPackageSubscriptionsCapability } from './list-package-subscriptions.ts'
import { packageAppFetchCapability } from './package-app-fetch.ts'
import { packageInvocationTokenGetCapability } from './package-invocation-token-get.ts'
import { packageInvocationTokenListCapability } from './package-invocation-token-list.ts'
import { packageSubscriptionDispatchCapability } from './package-subscription-dispatch.ts'
import { packageUpdateCapability } from './package-update.ts'
import { publishExternalPushCapability } from './publish-external-push.ts'
import { savePackageCapability } from './save-package.ts'

export const packagesDomain = defineDomain({
	name: capabilityDomainNames.packages,
	description:
		'Repo-backed saved packages with config, storage, apps, jobs, and subscriptions.',
	keywords: [
		'package',
		'repo',
		'package.json',
		'exports',
		'jobs',
		'app',
		'subscriptions',
		'event handlers',
		'test',
		'smoke',
		'simulate',
		'probe',
		'synthetic',
	],
	capabilities: [
		savePackageCapability,
		getPackageCapability,
		getGitRemoteCapability,
		listPackagesCapability,
		listPackageSubscriptionsCapability,
		packageAppFetchCapability,
		packageSubscriptionDispatchCapability,
		packageUpdateCapability,
		packageInvocationTokenListCapability,
		packageInvocationTokenGetCapability,
		publishExternalPushCapability,
		deletePackageCapability,
	],
})
