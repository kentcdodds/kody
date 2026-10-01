import { redactApiTokens } from '@kody-internal/shared/api-token-format.ts'
import {
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
	isJobIntervalFloorError,
} from '#worker/entitlements/errors.ts'

export const apiErrorCodes = [
	'invalid_request',
	'unauthorized',
	'insufficient_scope',
	'email_verification_required',
	'account_suspended',
	'feature_unavailable',
	'feature_disabled',
	'not_found',
	'method_not_allowed',
	'account_deleting',
	'payload_too_large',
	'unsupported_media_type',
	'rate_limited',
	'entitlement_limit',
	'capability_error',
	'package_import_unresolved',
	'package_import_unpublished',
	'unsupported_dynamic_package_import',
	'internal_error',
] as const

export type ApiErrorCode = (typeof apiErrorCodes)[number]

export type ApiErrorBody = {
	error: {
		code: ApiErrorCode
		message: string
		details?: unknown
	}
}

export class ApiError extends Error {
	readonly status: number
	readonly code: ApiErrorCode
	readonly details: unknown
	readonly headers: Record<string, string>
	/**
	 * Owning user for observe-only metering when auth fails before
	 * `invokeApiOperation`. Never serialized to clients.
	 */
	readonly meteringUserId?: string

	constructor(input: {
		status: number
		code: ApiErrorCode
		message: string
		details?: unknown
		headers?: Record<string, string>
		meteringUserId?: string
	}) {
		super(input.message)
		this.name = 'ApiError'
		this.status = input.status
		this.code = input.code
		this.details = input.details
		this.headers = input.headers ?? {}
		this.meteringUserId = input.meteringUserId
	}

	toBody(): ApiErrorBody {
		return {
			error: {
				code: this.code,
				message: redactApiTokens(this.message),
				...(this.details === undefined ? {} : { details: this.details }),
			},
		}
	}
}

export function invalidRequest(message: string, details?: unknown) {
	return new ApiError({
		status: 400,
		code: 'invalid_request',
		message,
		details,
	})
}

export function notFound(message: string) {
	return new ApiError({ status: 404, code: 'not_found', message })
}

/**
 * Map a thrown value to the public error envelope. Caller errors become
 * 400 (or 404 when they say something was not found); unknown errors are
 * 500 with a generic message so internals never leak.
 */
export function toApiError(error: unknown): ApiError {
	if (error instanceof ApiError) return error
	if (error instanceof AccountDeletionInProgressError) {
		return new ApiError({
			status: 409,
			code: 'account_deleting',
			message:
				'Account deletion is in progress; user-owned writes are disabled.',
		})
	}
	if (error instanceof AccountWriteLeaseLostError) {
		return new ApiError({
			status: 503,
			code: 'account_deleting',
			message:
				'Account deletion is in progress; retry after the current write finishes.',
		})
	}
	const limitError = getErrorCauseChain(error).find(
		(entry) =>
			isEntitlementLimitError(entry) || isComputeOverageLimitError(entry),
	)
	if (limitError) {
		return new ApiError({
			status: 429,
			code: 'entitlement_limit',
			message: getErrorMessage(limitError),
			details: limitError.details,
		})
	}
	if (isMcpCallerError(error) || isJobIntervalFloorError(error)) {
		const message = getErrorMessage(error)
		return /\bnot found\b/i.test(message)
			? notFound(message)
			: invalidRequest(message)
	}
	return new ApiError({
		status: 500,
		code: 'internal_error',
		message: 'Internal error. Retry later or report it if it persists.',
	})
}

export function apiErrorResponse(error: ApiError) {
	return Response.json(error.toBody(), {
		status: error.status,
		headers: { 'Cache-Control': 'no-store', ...error.headers },
	})
}
