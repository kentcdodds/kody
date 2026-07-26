import { canonicalJsonStringify } from '@kody-internal/shared/canonical-json.ts'
import { toHex } from '@kody-internal/shared/hex.ts'
import { type RunRecordContext } from '#worker/run-records/types.ts'
import { normalizeExportName, type PackageRuntimeContext } from './common.ts'
import { type ParsedPackageInvokeInput } from './input-parsing.ts'
import { buildJsonErrorResponse } from './responses.ts'
import {
	type getPackageInvocationByKey,
	type PackageInvocationStoredResponse,
} from './repo.ts'

export function markStoredResponseAsReplayed(
	response: PackageInvocationStoredResponse,
) {
	const body = structuredClone(response.body)
	const record = body as Record<string, unknown>
	const existingIdempotency = record['idempotency']
	if (existingIdempotency && typeof existingIdempotency === 'object') {
		record['idempotency'] = {
			...(existingIdempotency as Record<string, unknown>),
			replayed: true,
		}
	} else {
		record['idempotency'] = { replayed: true }
	}
	return {
		status: response.status,
		body,
	} satisfies PackageInvocationStoredResponse
}

export async function createRequestHash(input: {
	packageId: string
	exportName: string
	params?: Record<string, unknown>
	source: string | null
	topic: string | null
}) {
	const canonical = canonicalJsonStringify(input)
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(canonical),
	)
	return toHex(new Uint8Array(digest))
}

export async function createAutoPackageInvokeIdempotencyKey(input: {
	callerPackageContext: PackageRuntimeContext | null
	parentRunRecord: RunRecordContext | null
	sequence: number
	request: ParsedPackageInvokeInput
}) {
	if (!input.callerPackageContext) {
		return `pkginvoke:${crypto.randomUUID()}`
	}
	const parentKey = input.parentRunRecord?.idempotencyKey?.trim()
	if (!parentKey) {
		return `pkginvoke:${crypto.randomUUID()}`
	}
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(
			canonicalJsonStringify({
				callerPackageId: input.callerPackageContext.packageId,
				parentKey,
				parentSurface: input.parentRunRecord?.surface ?? null,
				parentName: input.parentRunRecord?.name ?? null,
				sequence: input.sequence,
				packageIdOrKodyId: input.request.packageIdOrKodyId,
				exportName: normalizeExportName(input.request.exportName),
				params: input.request.params,
				topic: input.request.topic,
			}),
		),
	)
	return [
		'pkginvoke',
		input.callerPackageContext.packageId,
		parentKey,
		String(input.sequence),
		toHex(new Uint8Array(digest)).slice(0, 24),
	].join(':')
}

function buildIdempotencyResponseUnavailable(input: {
	idempotencyKey: string
}) {
	return buildJsonErrorResponse({
		status: 409,
		code: 'idempotency_response_unavailable',
		message:
			'This idempotency key already has a terminal invocation record, but its stored response could not be replayed.',
		idempotencyKey: input.idempotencyKey,
	})
}

export function resolveExistingInvocation(input: {
	record: NonNullable<Awaited<ReturnType<typeof getPackageInvocationByKey>>>
	requestHash: string
	idempotencyKey: string
}): PackageInvocationStoredResponse {
	if (input.record.request_hash !== input.requestHash) {
		return buildJsonErrorResponse({
			status: 409,
			code: 'idempotency_mismatch',
			message:
				'This idempotency key has already been used for a different package invocation request.',
			idempotencyKey: input.idempotencyKey,
		})
	}
	if (input.record.status === 'in_progress') {
		return buildJsonErrorResponse({
			status: 409,
			code: 'invocation_in_progress',
			message:
				'This idempotency key is already processing for the requested package export.',
			idempotencyKey: input.idempotencyKey,
		})
	}
	if (input.record.storedResponse) {
		return markStoredResponseAsReplayed(input.record.storedResponse)
	}
	return buildIdempotencyResponseUnavailable({
		idempotencyKey: input.idempotencyKey,
	})
}
