import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { loadPublishedSourceSnapshot } from '#worker/package-runtime/published-runtime-artifacts.ts'
import {
	requiresPrivateVisibilityConfirmation,
	type PackagePrivateFieldValue,
	parsePackagePrivateField,
} from '#worker/package-registry/package-private.ts'
import {
	type ArtifactRepoHandle,
	type ArtifactToken,
	resolveArtifactDefaultBranchHead,
	resolveExistingArtifactSourceRepo,
} from './artifacts.ts'
import { type EntitySourceRow } from './types.ts'

export const productionPackageSourceSafetyPolicy =
	'Production package source safety policy: never replace source history, force publish, or package_save over an existing package unless Kody has created a restorable backup snapshot and the user explicitly approved destructive overwrite. If existing source cannot be cloned or verified, stop and report the source recovery problem.'

export const defaultPackagePrivateGuidance =
	'Default new saved packages to `"private": true` in package.json unless the user explicitly wants public community publishing. Like npm, `"private": true` blocks community listings on this deployment. When package.json omits `"private"` on create, Kody always saves the new package with `"private": true` — even when confirm_private_visibility_change is true. To create a package eligible for community publishing, set `"private": false` explicitly in package.json and pass confirm_private_visibility_change: true after explicit user approval.'

export const destructiveOverwriteConfirmationField =
	'confirm_destructive_overwrite'

export const destructiveOverwriteConfirmationDescription =
	'Set to true only when the user explicitly approved destructive overwrite of existing package source history. Kody still verifies a restorable backup snapshot before publishing.'

export const privateVisibilityChangeConfirmationField =
	'confirm_private_visibility_change'

export const privateVisibilityChangeConfirmationDescription =
	'Set to true only when the user explicitly approved changing package.json `"private"` or creating a package without `"private": true`. This flag is a confirmation gate, not a visibility request: it never changes `"private"` by itself. A new package whose manifest omits `"private"` is always saved with `"private": true`; send `"private": false` explicitly (plus this confirmation) to create a community-publishable package. This gates community publishing the same way npm blocks public registry publish for private packages.'

export function buildSourceRecoveryProblemMessage(input: {
	source: EntitySourceRow
	operation: string
	reason: string
}) {
	const publishedCommit = input.source.published_commit ?? 'none'
	return [
		`${input.operation} stopped by the production package source safety policy.`,
		`Kody could not verify a restorable backup snapshot for source "${input.source.id}" at published commit "${publishedCommit}": ${input.reason}`,
		'Stop and report this source recovery problem instead of rebuilding or overwriting the package in place.',
	].join(' ')
}

function buildDestructiveOverwriteConfirmationMessage(input: {
	source: EntitySourceRow
	operation: string
}) {
	return [
		`${input.operation} would overwrite existing package source "${input.source.id}".`,
		`Set ${destructiveOverwriteConfirmationField}: true only after the user explicitly approves destructive overwrite; Kody will also verify a restorable backup snapshot first.`,
	].join(' ')
}

export async function assertRestorablePackageSourceSnapshot(input: {
	env: Env
	userId: string
	source: EntitySourceRow
	operation: string
}) {
	if (input.source.entity_kind !== 'package') {
		return null
	}
	if (!input.source.published_commit) {
		throw new Error(
			buildSourceRecoveryProblemMessage({
				source: input.source,
				operation: input.operation,
				reason: 'the source has no published commit',
			}),
		)
	}
	let snapshot: Awaited<ReturnType<typeof loadPublishedSourceSnapshot>>
	try {
		snapshot = await loadPublishedSourceSnapshot({
			env: input.env,
			userId: input.userId,
			source: input.source,
		})
	} catch (error) {
		const message = getErrorMessage(error)
		throw new Error(
			buildSourceRecoveryProblemMessage({
				source: input.source,
				operation: input.operation,
				reason: message,
			}),
			{ cause: error },
		)
	}
	if (!snapshot) {
		throw new Error(
			buildSourceRecoveryProblemMessage({
				source: input.source,
				operation: input.operation,
				reason: 'no published source snapshot was found',
			}),
		)
	}
	if (
		typeof snapshot.files !== 'object' ||
		snapshot.files == null ||
		Array.isArray(snapshot.files)
	) {
		throw new Error(
			buildSourceRecoveryProblemMessage({
				source: input.source,
				operation: input.operation,
				reason: 'the published source snapshot is missing or malformed',
			}),
		)
	}
	const files = snapshot.files
	const fileCount = Object.keys(files).length
	const manifestContent = files[input.source.manifest_path]
	if (fileCount === 0) {
		throw new Error(
			buildSourceRecoveryProblemMessage({
				source: input.source,
				operation: input.operation,
				reason: 'the published source snapshot is empty',
			}),
		)
	}
	if (typeof manifestContent !== 'string' || manifestContent.trim() === '') {
		throw new Error(
			buildSourceRecoveryProblemMessage({
				source: input.source,
				operation: input.operation,
				reason: `the published source snapshot is missing manifest "${input.source.manifest_path}"`,
			}),
		)
	}
	return {
		sourceId: input.source.id,
		publishedCommit: input.source.published_commit,
		fileCount,
	}
}

export async function assertPublishedPackageSourceRepoHead(input: {
	env: Env
	source: EntitySourceRow
	operation: string
	requirePublishedCommitHead?: boolean
	accessToken?: {
		scope: 'read' | 'write'
		ttlSeconds: number
	}
}): Promise<{
	sourceId: string
	publishedCommit: string
	commit: string
	defaultBranch: string
	remote: string
	repo: ArtifactRepoHandle
	accessToken: ArtifactToken | null
} | null> {
	if (input.source.entity_kind !== 'package') {
		return null
	}
	if (!input.source.published_commit) {
		throw new Error(
			buildSourceRecoveryProblemMessage({
				source: input.source,
				operation: input.operation,
				reason: 'the source has no published commit',
			}),
		)
	}
	let repo: ArtifactRepoHandle | null
	try {
		repo = await resolveExistingArtifactSourceRepo(
			input.env,
			input.source.repo_id,
		)
	} catch (error) {
		const message = getErrorMessage(error)
		throw new Error(
			buildSourceRecoveryProblemMessage({
				source: input.source,
				operation: input.operation,
				reason: message,
			}),
			{ cause: error },
		)
	}
	if (!repo) {
		throw new Error(
			buildSourceRecoveryProblemMessage({
				source: input.source,
				operation: input.operation,
				reason: `artifact source repo "${input.source.repo_id}" was not found`,
			}),
		)
	}
	let head: Awaited<ReturnType<typeof resolveArtifactDefaultBranchHead>>
	let accessToken: ArtifactToken | null = null
	try {
		if (input.accessToken) {
			const [info, minted] = await Promise.all([
				repo.info(),
				repo.createToken(input.accessToken.scope, input.accessToken.ttlSeconds),
			])
			accessToken = minted
			head = await resolveArtifactDefaultBranchHead({
				repo,
				token: minted.plaintext,
				info,
			})
		} else {
			head = await resolveArtifactDefaultBranchHead({ repo })
		}
	} catch (error) {
		const message = getErrorMessage(error)
		throw new Error(
			buildSourceRecoveryProblemMessage({
				source: input.source,
				operation: input.operation,
				reason: message,
			}),
			{ cause: error },
		)
	}
	if (!head) {
		throw new Error(
			buildSourceRecoveryProblemMessage({
				source: input.source,
				operation: input.operation,
				reason: `artifact source repo "${input.source.repo_id}" default branch has no HEAD`,
			}),
		)
	}
	if (
		input.requirePublishedCommitHead === true &&
		head.commit !== input.source.published_commit
	) {
		throw new Error(
			buildSourceRecoveryProblemMessage({
				source: input.source,
				operation: input.operation,
				reason: `artifact source repo "${input.source.repo_id}" default branch HEAD "${head.commit}" does not match published commit "${input.source.published_commit}"`,
			}),
		)
	}
	return {
		sourceId: input.source.id,
		publishedCommit: input.source.published_commit,
		commit: head.commit,
		defaultBranch: head.defaultBranch,
		remote: head.remote,
		repo,
		accessToken,
	}
}

export async function assertPackageSourceOverwriteAllowed(input: {
	env: Env
	userId: string
	source: EntitySourceRow
	operation: string
	confirmed?: boolean
}) {
	if (input.source.entity_kind !== 'package') {
		return null
	}
	if (input.confirmed !== true) {
		throw new Error(
			buildDestructiveOverwriteConfirmationMessage({
				source: input.source,
				operation: input.operation,
			}),
		)
	}
	return await assertRestorablePackageSourceSnapshot(input)
}

function describePackagePrivateField(
	value: PackagePrivateFieldValue | 'missing',
): string {
	if (value === true) return '"private": true'
	if (value === false) return '"private": false'
	return 'no "private" field'
}

function buildPrivateVisibilityChangeConfirmationMessage(input: {
	operation: string
	beforeContent: string | null | undefined
	afterContent: string
	isNewPackage: boolean
}) {
	const afterValue = parsePackagePrivateField(input.afterContent)
	const beforeValue =
		input.beforeContent == null
			? 'missing'
			: parsePackagePrivateField(input.beforeContent)
	if (input.isNewPackage) {
		return [
			`${input.operation} would create a package that is not private-only (${describePackagePrivateField(afterValue)}).`,
			`Set ${privateVisibilityChangeConfirmationField}: true only after the user explicitly approves making the package eligible for public community publishing.`,
		].join(' ')
	}
	return [
		`${input.operation} would change package.json private visibility from ${describePackagePrivateField(beforeValue)} to ${describePackagePrivateField(afterValue)}.`,
		`Set ${privateVisibilityChangeConfirmationField}: true only after the user explicitly approves the visibility change.`,
	].join(' ')
}

export function assertPackagePrivateVisibilityChangeAllowed(input: {
	beforeContent: string | null | undefined
	afterContent: string
	isNewPackage: boolean
	operation: string
	confirmed?: boolean
}) {
	if (
		!requiresPrivateVisibilityConfirmation({
			beforeContent: input.beforeContent,
			afterContent: input.afterContent,
			isNewPackage: input.isNewPackage,
		})
	) {
		return
	}
	if (input.confirmed !== true) {
		throw new Error(
			buildPrivateVisibilityChangeConfirmationMessage({
				operation: input.operation,
				beforeContent: input.beforeContent,
				afterContent: input.afterContent,
				isNewPackage: input.isNewPackage,
			}),
		)
	}
}

export async function loadPriorPackageManifestContent(input: {
	env: Env
	userId: string
	source: EntitySourceRow
}): Promise<string | null> {
	if (
		input.source.entity_kind !== 'package' ||
		!input.source.published_commit
	) {
		return null
	}
	const snapshot = await loadPublishedSourceSnapshot({
		env: input.env,
		userId: input.userId,
		source: input.source,
	})
	if (!snapshot) {
		return null
	}
	const manifestContent = snapshot.files[input.source.manifest_path]
	return typeof manifestContent === 'string' ? manifestContent : null
}
