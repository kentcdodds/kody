import {
	errorCauseChainIncludes,
	getErrorCauseChain,
	getErrorMessage,
} from '@kody-internal/shared/error-message.ts'
import { isMcpCallerError } from '#mcp/caller-error.ts'
import {
	AccountDeletionInProgressError,
	AccountWriteLeaseLostError,
} from '#worker/account/deletion-state.ts'
import {
	isComputeOverageLimitError,
	isEntitlementLimitError,
} from '#worker/entitlements/errors.ts'
import { artifactsBindingErrorCode } from '#worker/repo/artifacts.ts'
import { isDurableObjectIsolateResourceLimitResetMessage } from '#worker/sentry-options.ts'
import {
	CommunityActionError,
	CommunityForkResourceLimitError,
	communityForkResourceLimitMessage,
} from './errors.ts'
import {
	type CommunityForkFailureContext,
	toCommunityForkStepError,
} from './fork-failure.ts'

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

function isCommunityForkCallerFacingError(error: unknown) {
	if (
		error instanceof CommunityActionError ||
		error instanceof AccountDeletionInProgressError ||
		error instanceof AccountWriteLeaseLostError ||
		isMcpCallerError(error)
	) {
		return true
	}
	return getErrorCauseChain(error).some(
		(entry) =>
			isEntitlementLimitError(entry) || isComputeOverageLimitError(entry),
	)
}

/**
 * Caller-facing failures (bad input, limits, account state) pass through.
 * Everything else becomes a `CommunityForkStepError` so MCP and website
 * install name the failing step, upstream class, and a logged report id
 * instead of the generic internal error.
 */
export function rethrowCommunityForkFailure(
	error: unknown,
	context: CommunityForkFailureContext,
): never {
	if (error instanceof CommunityForkResourceLimitError) throw error
	if (isCommunityForkResourceLimitCause(error)) {
		throw new CommunityForkResourceLimitError(error)
	}
	if (isCommunityForkCallerFacingError(error)) throw error
	throw toCommunityForkStepError(error, context)
}

export function communityForkResourceLimitLogFields(error: unknown) {
	return {
		message: 'community-fork-resource-limit',
		error: getErrorMessage(error),
		userMessage: communityForkResourceLimitMessage,
	}
}
