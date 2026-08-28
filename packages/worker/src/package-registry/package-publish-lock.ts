import { routes } from '#universal/routes.ts'
import { getSavedPackageById } from './repo.ts'
import { type SavedPackageRecord } from './types.ts'

const gitCommitShaPattern = /^[0-9a-f]{7,64}$/i

export class PackagePublishLockedError extends Error {
	readonly packageId: string
	readonly packageName: string
	readonly pendingCommit: string
	readonly currentPublishedCommit: string | null
	readonly approvalPath: string

	constructor(input: {
		packageId: string
		packageName: string
		pendingCommit: string
		currentPublishedCommit: string | null
	}) {
		const approvalPath = buildPackagePublishApprovalPath({
			packageId: input.packageId,
			commit: input.pendingCommit,
		})
		super(
			`Package "${input.packageName}" is locked. Publishes require approval at ${approvalPath}.`,
		)
		this.name = 'PackagePublishLockedError'
		this.packageId = input.packageId
		this.packageName = input.packageName
		this.pendingCommit = input.pendingCommit
		this.currentPublishedCommit = input.currentPublishedCommit
		this.approvalPath = approvalPath
	}
}

export function isPackagePublishLockedError(
	error: unknown,
): error is PackagePublishLockedError {
	return error instanceof PackagePublishLockedError
}

export function isSavedPackageLocked(
	lockedAt: string | null | undefined,
): boolean {
	return typeof lockedAt === 'string' && lockedAt.trim().length > 0
}

export function isGitCommitSha(value: string): boolean {
	return gitCommitShaPattern.test(value.trim())
}

export function buildPackagePublishApprovalPath(input: {
	packageId: string
	commit: string
}): string {
	const url = new URL(
		routes.accountPackageApprovePublish.href({
			packageId: input.packageId,
		}),
		'https://kody.invalid',
	)
	url.searchParams.set('commit', input.commit)
	return `${url.pathname}${url.search}`
}

export function buildPackagePublishApprovalUrl(input: {
	baseUrl: string
	packageId: string
	commit: string
}): string {
	const url = new URL(
		buildPackagePublishApprovalPath({
			packageId: input.packageId,
			commit: input.commit,
		}),
		input.baseUrl,
	)
	return url.toString()
}

export function buildPackageUnlockPath(packageId: string): string {
	return routes.accountPackageDetail.href({ packageId })
}

export function buildPackageUnlockUrl(input: {
	baseUrl: string
	packageId: string
}): string {
	return new URL(
		buildPackageUnlockPath(input.packageId),
		input.baseUrl,
	).toString()
}

export function createPackageUnlockRequiredMessage(unlockUrl: string): string {
	return `Agents cannot unlock packages. Send the owner to ${unlockUrl} to unlock publishes.`
}

export function createPackagePublishLockedMessage(input: {
	packageName: string
	approvalUrl: string
}): string {
	return `Package "${input.packageName}" is locked. Publishes require approval at ${input.approvalUrl}.`
}

export function createPackagePublishLockedError(input: {
	savedPackage: Pick<SavedPackageRecord, 'id' | 'name' | 'lockedAt'>
	pendingCommit: string
	currentPublishedCommit: string | null
}): PackagePublishLockedError {
	return new PackagePublishLockedError({
		packageId: input.savedPackage.id,
		packageName: input.savedPackage.name,
		pendingCommit: input.pendingCommit,
		currentPublishedCommit: input.currentPublishedCommit,
	})
}

export async function loadLockedSavedPackage(input: {
	db: D1Database
	userId: string
	packageId: string
}): Promise<SavedPackageRecord | null> {
	const savedPackage = await getSavedPackageById(input.db, {
		userId: input.userId,
		packageId: input.packageId,
	})
	if (!savedPackage || !isSavedPackageLocked(savedPackage.lockedAt)) {
		return null
	}
	return savedPackage
}
