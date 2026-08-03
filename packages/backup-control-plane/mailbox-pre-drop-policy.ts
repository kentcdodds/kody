import { mailboxPreDropObjectPrefix } from '@kody-internal/shared/mailbox-pre-drop-approval.ts'

import {
	BackupError,
	assertConfiguredIdentity,
	utcDay,
} from './backup-policy.ts'
import {
	type BackupEnvironment,
	type MailboxPreDropBackupRequest,
	type MailboxPreDropRuntimePayload,
} from './backup-types.ts'

const requestIdPattern =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const noncePattern = /^[0-9a-f]{32}$/
const maximumRequestAgeMilliseconds = 15 * 60 * 1_000

function isPlainDataRecord(value: unknown): value is Record<string, unknown> {
	return (
		value !== null &&
		typeof value === 'object' &&
		!Array.isArray(value) &&
		Object.getPrototypeOf(value) === Object.prototype
	)
}

function hasExactDataKeys(
	value: Record<string, unknown>,
	expected: ReadonlyArray<string>,
): boolean {
	const actual = Reflect.ownKeys(value)
	return (
		actual.length === expected.length &&
		actual.every((key) => typeof key === 'string' && expected.includes(key)) &&
		expected.every((key) => {
			const descriptor = Object.getOwnPropertyDescriptor(value, key)
			return descriptor?.enumerable === true && 'value' in descriptor
		})
	)
}

function parseCanonicalTimestamp(value: unknown): string | null {
	if (typeof value !== 'string') return null
	const timestamp = new Date(value)
	if (
		!Number.isFinite(timestamp.valueOf()) ||
		timestamp.toISOString() !== value
	) {
		return null
	}
	return value
}

export function mailboxPreDropWorkflowInstanceId(
	request: MailboxPreDropBackupRequest,
): string {
	return `mailbox-pre-drop-${request.requestId}`
}

export function parseMailboxPreDropBackupRequest(
	value: unknown,
	eventTimestamp: Date,
	instanceId: string,
): MailboxPreDropBackupRequest {
	if (
		!isPlainDataRecord(value) ||
		!hasExactDataKeys(value, ['nonce', 'requestId', 'requestedAt']) ||
		typeof value.requestId !== 'string' ||
		!requestIdPattern.test(value.requestId) ||
		typeof value.nonce !== 'string' ||
		!noncePattern.test(value.nonce)
	) {
		throw new BackupError(
			'invalid-mailbox-pre-drop-request',
			'pre-drop backup params require only a canonical UUID requestId, 32-character lowercase hexadecimal nonce, and requestedAt',
		)
	}
	const requestedAt = parseCanonicalTimestamp(value.requestedAt)
	if (requestedAt === null || !Number.isFinite(eventTimestamp.valueOf())) {
		throw new BackupError(
			'invalid-mailbox-pre-drop-request',
			'pre-drop backup requestedAt and Workflow event timestamp must be canonical timestamps',
		)
	}
	const request: MailboxPreDropBackupRequest = {
		requestId: value.requestId,
		nonce: value.nonce,
		requestedAt,
	}
	if (instanceId !== mailboxPreDropWorkflowInstanceId(request)) {
		throw new BackupError(
			'invalid-mailbox-pre-drop-instance-id',
			'Workflow instance id must be derived exactly from requestId',
		)
	}
	const age = eventTimestamp.valueOf() - Date.parse(requestedAt)
	if (age > maximumRequestAgeMilliseconds || age < 0) {
		throw new BackupError(
			'stale-mailbox-pre-drop-request',
			'pre-drop backup requestedAt must be fresh at Workflow creation',
		)
	}
	return request
}

export function mailboxPreDropRuntimePayload(
	env: BackupEnvironment,
	request: MailboxPreDropBackupRequest,
): MailboxPreDropRuntimePayload {
	assertConfiguredIdentity(env)
	const objectPrefix = mailboxPreDropObjectPrefix({
		sourceDatabaseId: env.SOURCE_DATABASE_ID,
		exportScheduledAt: request.requestedAt,
		nonce: request.nonce,
		requestId: request.requestId,
	})
	return {
		kind: 'mailbox-legacy-graph-pre-drop',
		...request,
		scheduledAt: request.requestedAt,
		day: utcDay(new Date(request.requestedAt)),
		objectPrefix,
		manifestKey: `${objectPrefix}/manifest.json`,
		retentionTier: 'daily',
	}
}
