import { getErrorCauseChain } from '@kody-internal/shared/error-message.ts'

/**
 * Artifacts sub-operation that threw. Tags ride beside the original error
 * (same identity and message) so existing detectors keep working; fork
 * failure reports read them to name the failing step.
 */
export type ArtifactsFailedOperation =
	| 'repo_get'
	| 'repo_create'
	| 'get_after_create'
	| 'create_after_conflict'
	| 'list_server_refs'
	| 'git_fetch'
	| 'git_clone'

type ArtifactsFailureTag = {
	operation?: ArtifactsFailedOperation
	httpStatus?: number
}

const artifactsFailureTags = new WeakMap<object, ArtifactsFailureTag>()

export function tagArtifactsFailure<T>(error: T, tag: ArtifactsFailureTag): T {
	if (error === null || typeof error !== 'object') return error
	const existing = artifactsFailureTags.get(error)
	artifactsFailureTags.set(error, {
		operation: existing?.operation ?? tag.operation,
		httpStatus: existing?.httpStatus ?? tag.httpStatus,
	})
	return error
}

export async function runTaggedArtifactsOperation<T>(
	operation: ArtifactsFailedOperation,
	run: () => Promise<T> | T,
): Promise<T> {
	try {
		return await run()
	} catch (error) {
		throw tagArtifactsFailure(error, { operation })
	}
}

const gitWrapperOperationPattern =
	/^Artifacts (listServerRefs|git fetch|git clone) failed for /i

function operationFromGitWrapperMessage(
	message: string,
): ArtifactsFailedOperation | null {
	const match = gitWrapperOperationPattern.exec(message.trim())
	switch (match?.[1]?.toLowerCase()) {
		case 'listserverrefs':
			return 'list_server_refs'
		case 'git fetch':
			return 'git_fetch'
		case 'git clone':
			return 'git_clone'
		default:
			return null
	}
}

/**
 * Innermost tagged operation wins; git wrapper messages also count because
 * those errors often cross a Durable Object RPC boundary where WeakMap tags
 * do not survive.
 */
export function readArtifactsFailureTag(error: unknown): {
	operation: ArtifactsFailedOperation | null
	httpStatus: number | null
} {
	let operation: ArtifactsFailedOperation | null = null
	let httpStatus: number | null = null
	for (const entry of getErrorCauseChain(error)) {
		if (entry !== null && typeof entry === 'object') {
			const tag = artifactsFailureTags.get(entry)
			if (tag?.operation) operation = tag.operation
			if (tag?.httpStatus != null) httpStatus = tag.httpStatus
		}
		if (entry instanceof Error) {
			const fromMessage = operationFromGitWrapperMessage(entry.message)
			if (fromMessage) operation = fromMessage
		}
	}
	return { operation, httpStatus }
}
