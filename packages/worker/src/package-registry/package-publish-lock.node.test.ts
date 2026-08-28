import { expect, test } from 'vitest'
import {
	PackagePublishLockedError,
	buildPackagePublishApprovalPath,
	buildPackagePublishApprovalUrl,
	buildPackageUnlockPath,
	buildPackageUnlockUrl,
	createPackagePublishLockedMessage,
	isGitCommitSha,
	isSavedPackageLocked,
} from './package-publish-lock.ts'

test('publish lock treats a stored timestamp as locked and builds a commit-named approval URL', () => {
	expect(isSavedPackageLocked(null)).toBe(false)
	expect(isSavedPackageLocked(undefined)).toBe(false)
	expect(isSavedPackageLocked('')).toBe(false)
	expect(isSavedPackageLocked('   ')).toBe(false)
	expect(isSavedPackageLocked('2026-08-28T12:00:00.000Z')).toBe(true)

	expect(isGitCommitSha('7f3a91c')).toBe(true)
	expect(isGitCommitSha('7f3a91c2e8b4d0aa')).toBe(true)
	expect(isGitCommitSha('not-a-sha')).toBe(false)
	expect(isGitCommitSha('')).toBe(false)

	expect(
		buildPackagePublishApprovalPath({
			packageId: 'pkg-1',
			commit: 'abc1234',
		}),
	).toBe('/account/packages/pkg-1/approve-publish?commit=abc1234')
	expect(
		buildPackagePublishApprovalUrl({
			baseUrl: 'https://kody.codes',
			packageId: 'pkg-1',
			commit: 'abc1234',
		}),
	).toBe(
		'https://kody.codes/account/packages/pkg-1/approve-publish?commit=abc1234',
	)

	expect(
		createPackagePublishLockedMessage({
			packageName: '@user/notes',
			approvalUrl:
				'https://kody.codes/account/packages/pkg-1/approve-publish?commit=abc1234',
		}),
	).toBe(
		'Package "@user/notes" is locked. Publishes require approval at https://kody.codes/account/packages/pkg-1/approve-publish?commit=abc1234.',
	)

	const error = new PackagePublishLockedError({
		packageId: 'pkg-1',
		packageName: '@user/notes',
		pendingCommit: 'abc1234',
		currentPublishedCommit: 'oldcommit',
	})
	expect(error.approvalPath).toBe(
		'/account/packages/pkg-1/approve-publish?commit=abc1234',
	)
	expect(error.message).toContain(
		'/account/packages/pkg-1/approve-publish?commit=abc1234',
	)

	expect(buildPackageUnlockPath('pkg-1')).toBe('/account/packages/pkg-1')
	expect(
		buildPackageUnlockUrl({
			baseUrl: 'https://kody.codes',
			packageId: 'pkg-1',
		}),
	).toBe('https://kody.codes/account/packages/pkg-1')
})
