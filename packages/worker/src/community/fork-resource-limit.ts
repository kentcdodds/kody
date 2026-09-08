import {
	errorCauseChainIncludes,
	getErrorCauseChain,
	getErrorMessage,
} from '@kody-internal/shared/error-message.ts'
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
	if (error === null || typeof error !== 'object') return false
	return (error as { code?: unknown }).code === 'MEMORY_LIMIT'
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
	throw error
}

export function communityForkResourceLimitLogFields(error: unknown) {
	return {
		message: 'community-fork-resource-limit',
		error: getErrorMessage(error),
		userMessage: communityForkResourceLimitMessage,
	}
}
