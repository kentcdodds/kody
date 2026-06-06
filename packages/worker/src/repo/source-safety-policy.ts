import { loadPublishedSourceSnapshot } from '#worker/package-runtime/published-runtime-artifacts.ts'
import { type EntitySourceRow } from './types.ts'

export const productionPackageSourceSafetyPolicy =
	'Production package source safety policy: never replace source history, force publish, or package_save over an existing package unless Kody has created a restorable backup snapshot and the user explicitly approved destructive overwrite. If existing source cannot be cloned or verified, stop and report the source recovery problem.'

export const destructiveOverwriteConfirmationField =
	'confirm_destructive_overwrite'

export const destructiveOverwriteConfirmationDescription =
	'Set to true only when the user explicitly approved destructive overwrite of existing package source history. Kody still verifies a restorable backup snapshot before publishing.'

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
		const message = error instanceof Error ? error.message : String(error)
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
