import { redactKodyCredentials } from '@kody-internal/shared/api-token-format.ts'
import {
	getErrorCauseChain,
	getErrorMessage,
} from '@kody-internal/shared/error-message.ts'
import { CloudflareApiError } from '#mcp/cloudflare/cloudflare-rest-client.ts'
import { artifactsBindingErrorCode } from '#worker/repo/artifacts.ts'
import {
	type ArtifactsFailedOperation,
	readArtifactsFailureTag,
} from '#worker/repo/artifacts-failure-tag.ts'
import {
	classifyArtifactsGitExhaustedFailure,
	isArtifactsGitTransientRemapError,
} from '#worker/repo/artifacts-git-retry.ts'

/**
 * Phase of community fork / one-click install that threw. Values are stable
 * log and Open API `details.failed_step` labels.
 */
export type CommunityForkFailedStep =
	| 'prepare'
	| 'artifacts_fork'
	| 'ensure_source'
	| 'persist_forked_contents'
	| 'fallback_tree'
	| 'fallback_delete'
	| 'fallback_ensure_source'
	| 'fallback_sync'
	| 'sync_snapshot'
	| 'fork_row'
	| 'install_checks'
	| 'install_recheck'
	| 'install_projection'

/** Coarse upstream class. Never carries remotes, hosts, or tokens. */
export type CommunityForkUpstreamStatusClass =
	| 'http_5xx'
	| 'http_429'
	| 'http_4xx'
	| 'packfile_corruption'
	| 'timeout'
	| 'missing_object'
	| 'not_found'
	| 'already_exists'
	| 'in_progress'
	| 'unclassified'

export type CommunityForkFailureContext = {
	step: CommunityForkFailedStep
	/**
	 * Set when the dest-clone fallback gave up and rethrew the original
	 * `step` error; names the fallback phase that could not continue.
	 */
	fallbackStoppedAt?: CommunityForkFailedStep
	listingId?: string
	packageId?: string
}

function readCloudflareApiStatus(error: unknown) {
	const apiError = getErrorCauseChain(error).find(
		(entry) => entry instanceof CloudflareApiError,
	)
	return apiError instanceof CloudflareApiError ? apiError.status : null
}

function readArtifactsRestStatusFromMessage(error: unknown) {
	for (const entry of getErrorCauseChain(error)) {
		const match = /Artifacts API request failed \((\d{3})\)/.exec(
			getErrorMessage(entry),
		)
		if (match?.[1]) return Number(match[1])
	}
	return null
}

function classifyArtifactsRepoState(
	error: unknown,
): CommunityForkUpstreamStatusClass | null {
	for (const entry of getErrorCauseChain(error)) {
		switch (artifactsBindingErrorCode(entry)) {
			case 'NOT_FOUND':
				return 'not_found'
			case 'ALREADY_EXISTS':
				return 'already_exists'
			case 'IMPORT_IN_PROGRESS':
			case 'FORK_IN_PROGRESS':
				return 'in_progress'
			default:
				break
		}
		const message = getErrorMessage(entry)
		if (/ is not_found after create conflict\./.test(message)) {
			return 'not_found'
		}
		if (/^Artifacts repo "[^"]+" was not found\./.test(message)) {
			return 'not_found'
		}
		if (/^Artifacts repo "[^"]+" is importing\b/.test(message)) {
			return 'in_progress'
		}
	}
	return null
}

function classifyHttpStatus(
	httpStatus: number | null,
): CommunityForkUpstreamStatusClass | null {
	if (httpStatus == null) return null
	if (httpStatus === 429) return 'http_429'
	if (httpStatus >= 500 && httpStatus <= 599) return 'http_5xx'
	if (httpStatus >= 400 && httpStatus <= 499) return 'http_4xx'
	return null
}

export function classifyCommunityForkUpstream(error: unknown): {
	operation: ArtifactsFailedOperation | null
	statusClass: CommunityForkUpstreamStatusClass
	httpStatus: number | null
} {
	const tag = readArtifactsFailureTag(error)
	const git = classifyArtifactsGitExhaustedFailure(error)
	const httpStatus =
		git.httpStatus ??
		tag.httpStatus ??
		readCloudflareApiStatus(error) ??
		readArtifactsRestStatusFromMessage(error)
	const base = { operation: tag.operation, httpStatus }
	switch (git.statusClass) {
		case 'packfile_corruption':
		case 'timeout':
		case 'missing_object':
			return { ...base, statusClass: git.statusClass }
		case 'http_5xx':
		case 'http_429':
		case 'unknown':
			break
		default: {
			const exhaustive: never = git.statusClass
			throw new Error(`Unhandled Artifacts git class: ${String(exhaustive)}`)
		}
	}
	const statusClass =
		classifyHttpStatus(httpStatus) ??
		classifyArtifactsRepoState(error) ??
		'unclassified'
	return { ...base, statusClass }
}

export function communityForkUpstreamStatusLabel(input: {
	statusClass: CommunityForkUpstreamStatusClass
	httpStatus: number | null
}) {
	const exactHttp = input.httpStatus != null ? `HTTP ${input.httpStatus}` : null
	switch (input.statusClass) {
		case 'http_5xx':
			return exactHttp ?? 'HTTP 5xx'
		case 'http_429':
			return 'HTTP 429'
		case 'http_4xx':
			return exactHttp ?? 'HTTP 4xx'
		case 'packfile_corruption':
			return 'corrupt pack'
		case 'timeout':
			return 'timeout'
		case 'missing_object':
			return 'missing object or ref'
		case 'not_found':
			return 'repo not found'
		case 'already_exists':
			return 'repo already exists'
		case 'in_progress':
			return 'repo not ready'
		case 'unclassified':
			return 'unclassified'
		default: {
			const exhaustive: never = input.statusClass
			throw new Error(
				`Unhandled community fork status class: ${String(exhaustive)}`,
			)
		}
	}
}

/**
 * Community fork / install failure with a report id, the failing step, and a
 * coarse upstream class. Open API keeps `internal_error` (503 when Artifacts
 * git transients exhausted retries, else 500) and copies these into details.
 */
export class CommunityForkStepError extends Error {
	readonly reportId: string
	readonly step: CommunityForkFailedStep
	readonly fallbackStoppedAt: CommunityForkFailedStep | null
	readonly operation: ArtifactsFailedOperation | null
	readonly statusClass: CommunityForkUpstreamStatusClass
	readonly httpStatus: number | null
	readonly artifactsGitTransient: boolean

	constructor(input: {
		step: CommunityForkFailedStep
		fallbackStoppedAt?: CommunityForkFailedStep
		cause: unknown
		reportId?: string
	}) {
		const reportId = input.reportId ?? crypto.randomUUID()
		const classified = classifyCommunityForkUpstream(input.cause)
		const artifactsGitTransient = isArtifactsGitTransientRemapError(input.cause)
		const lead = artifactsGitTransient
			? 'The package source could not be read after retries.'
			: 'Internal error while forking.'
		const stepLabel = classified.operation
			? `${input.step} (${classified.operation})`
			: input.step
		const fallbackLabel = input.fallbackStoppedAt
			? `; fallback stopped at ${input.fallbackStoppedAt}`
			: ''
		super(
			`${lead} Failed step: ${stepLabel}${fallbackLabel}; upstream status: ${communityForkUpstreamStatusLabel(classified)}. Report id: ${reportId}.`,
			{ cause: input.cause },
		)
		this.name = 'CommunityForkStepError'
		this.reportId = reportId
		this.step = input.step
		this.fallbackStoppedAt = input.fallbackStoppedAt ?? null
		this.operation = classified.operation
		this.statusClass = classified.statusClass
		this.httpStatus = classified.httpStatus
		this.artifactsGitTransient = artifactsGitTransient
	}

	get apiStatus() {
		return this.artifactsGitTransient ? 503 : 500
	}

	toApiDetails() {
		return {
			report_id: this.reportId,
			failed_step: this.step,
			...(this.fallbackStoppedAt
				? { fallback_stopped_at: this.fallbackStoppedAt }
				: {}),
			...(this.operation ? { artifacts_operation: this.operation } : {}),
			upstream_status_class: this.statusClass,
			...(this.httpStatus != null ? { upstream_status: this.httpStatus } : {}),
		}
	}
}

function redactUrlCredentials(value: string) {
	return value.replace(/\bhttps?:\/\/[^\s"'<>]+/gi, (match) => {
		try {
			const url = new URL(match)
			url.username = ''
			url.password = ''
			url.search = ''
			url.hash = ''
			return url.toString()
		} catch {
			return '[unparseable-url]'
		}
	})
}

export function redactCommunityForkLogMessage(message: string) {
	return redactKodyCredentials(redactUrlCredentials(message)).replace(
		/\bart_v1_[^\s"'<>]+/g,
		'art_v1_[redacted]',
	)
}

export function toCommunityForkStepError(
	error: unknown,
	context: CommunityForkFailureContext,
): CommunityForkStepError {
	if (error instanceof CommunityForkStepError) return error
	const stepError = new CommunityForkStepError({
		step: context.step,
		fallbackStoppedAt: context.fallbackStoppedAt,
		cause: error,
	})
	console.error(
		JSON.stringify({
			message: 'community-fork-failed',
			reportId: stepError.reportId,
			step: stepError.step,
			fallbackStoppedAt: stepError.fallbackStoppedAt,
			operation: stepError.operation,
			statusClass: stepError.statusClass,
			httpStatus: stepError.httpStatus,
			listingId: context.listingId,
			packageId: context.packageId,
			causes: getErrorCauseChain(error)
				.slice(0, 4)
				.map((entry) =>
					redactCommunityForkLogMessage(getErrorMessage(entry)).slice(0, 500),
				),
		}),
	)
	return stepError
}
