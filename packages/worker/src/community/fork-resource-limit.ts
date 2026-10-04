import {
	errorCauseChainIncludes,
	getErrorCauseChain,
	getErrorMessage,
} from '@kody-internal/shared/error-message.ts'
import { artifactsBindingErrorCode } from '#worker/repo/artifacts.ts'
import {
	artifactsGitTemporarilyUnavailableMessage,
	isArtifactsGitTransientRemapError,
} from '#worker/repo/artifacts-git-retry.ts'
import { isDurableObjectIsolateResourceLimitResetMessage } from '#worker/sentry-options.ts'
import {
	CommunityForkResourceLimitError,
	communityForkResourceLimitMessage,
} from './errors.ts'

export {
	CommunityForkResourceLimitError,
	communityForkResourceLimitMessage,
} from './errors.ts'

function isArtifactsMemoryLimitError(error: unknown) {
	if (
		error !== null &&
		typeof error === 'object' &&
		(error as { code?: unknown }).code === 'MEMORY_LIMIT'
	) {
		return true
	}
	return artifactsBindingErrorCode(error) === 'MEMORY_LIMIT'
}

export function isCommunityForkResourceLimitCause(error: unknown) {
	if (error instanceof CommunityForkResourceLimitError) return true
	if (getErrorCauseChain(error).some(isArtifactsMemoryLimitError)) return true
	return errorCauseChainIncludes(
		error,
		isDurableObjectIsolateResourceLimitResetMessage,
	)
}

export function rethrowCommunityForkFailure(error: unknown): never {
	if (error instanceof CommunityForkResourceLimitError) throw error
	if (isCommunityForkResourceLimitCause(error)) {
		throw new CommunityForkResourceLimitError(error)
	}
	// Same class as Open API `toApiError` Artifacts remap: fork (MCP capability
	// and website install) must surface a retry next step, not remotes/status.
	if (isArtifactsGitTransientRemapError(error)) {
		throw new Error(artifactsGitTemporarilyUnavailableMessage, {
			cause: error,
		})
	}
	throw error
}

export function communityForkResourceLimitLogFields(error: unknown) {
	return {
		message: 'community-fork-resource-limit',
		error: getErrorMessage(error),
		userMessage: communityForkResourceLimitMessage,
	}
}
