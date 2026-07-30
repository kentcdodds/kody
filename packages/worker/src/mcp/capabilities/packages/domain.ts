import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import { capabilityDomainNames } from '../domain-metadata.ts'
import { deletePackageCapability } from './delete-package.ts'
import { getGitRemoteCapability } from './get-git-remote.ts'
import { getPackageCapability } from './get-package.ts'
import { listPackagesCapability } from './list-packages.ts'
import { listPackageSubscriptionsCapability } from './list-package-subscriptions.ts'
import { packageCodemodApplyCapability } from './package-codemod-apply.ts'
import { packageCodemodDryRunCapability } from './package-codemod-dry-run.ts'
import { packageCodemodListCapability } from './package-codemod-list.ts'
import { packageCodemodRevertCapability } from './package-codemod-revert.ts'
import { packageCodemodScanCapability } from './package-codemod-scan.ts'
import { packageInvocationTokenGetCapability } from './package-invocation-token-get.ts'
import { packageInvocationTokenListCapability } from './package-invocation-token-list.ts'
import { packageUpdateCapability } from './package-update.ts'
import { publishExternalPushCapability } from './publish-external-push.ts'
import { savePackageCapability } from './save-package.ts'

export const packagesDomain = defineDomain({
	name: capabilityDomainNames.packages,
	description:
		'Saved packages are the only top-level persisted primitive: repo-backed source rooted at package.json, package-scoped config (secrets/values), durable package storage via packageStorage(), and optional apps, services, jobs, and other package.json#kody surfaces. Includes self-scoped package codemod list/scan/dry-run/apply/revert over the caller’s own published trees.',
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
		'codemod',
		'package codemod',
		'migration',
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
		publishExternalPushCapability,
		deletePackageCapability,
		packageCodemodListCapability,
		packageCodemodScanCapability,
		packageCodemodDryRunCapability,
		packageCodemodApplyCapability,
		packageCodemodRevertCapability,
	],
})
