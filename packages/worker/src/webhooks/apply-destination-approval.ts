import { sha256Hex } from '@kody-internal/shared/sha256.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import {
	webhookUrlApplyHttpMethods,
	webhookUrlApplyPlaceholder,
	type WebhookUrlApplyHttpDestination,
} from './apply.ts'
import { formatWebhookUrlHandle, parseWebhookUrlHandle } from './handle.ts'
import { getWebhookEndpointByIdForUser } from './repo.ts'

const connectWebhookApplyPath = '/connect/webhook-apply'

export type HttpApplyDestinationSnapshot = {
	method: (typeof webhookUrlApplyHttpMethods)[number]
	url: string
	headers: Array<{ name: string; value: string }>
	body: string
	secretName: string | null
	integration: string | null
	injectionSites: Array<string>
	auth: string
}

export type WebhookApplyDestinationApprovalView = {
	handle: string
	fingerprint: string
	packageId: string
	packageKodyId: string
	packageName: string
	webhookName: string
	destination: HttpApplyDestinationSnapshot
	alreadyGranted: boolean
}

type PendingOrGrantRow = {
	user_id: string
	webhook_endpoint_id: string
	destination_fingerprint: string
	destination_json: string
	package_id: string
	webhook_name: string
	created_at?: string
	updated_at?: string
	approved_at?: string
}

function normalizeHttpMethod(
	method: WebhookUrlApplyHttpDestination['method'] | undefined,
): (typeof webhookUrlApplyHttpMethods)[number] {
	const normalized = (method ?? 'POST').toUpperCase()
	if (
		(webhookUrlApplyHttpMethods as ReadonlyArray<string>).includes(normalized)
	) {
		return normalized as (typeof webhookUrlApplyHttpMethods)[number]
	}
	return 'POST'
}

function listInjectionSites(destination: {
	url: string
	headers: Record<string, string>
	body: string
}) {
	const sites: Array<string> = []
	if (destination.url.includes(webhookUrlApplyPlaceholder)) sites.push('url')
	for (const [name, value] of Object.entries(destination.headers)) {
		if (value.includes(webhookUrlApplyPlaceholder)) {
			sites.push(`header:${name}`)
		}
	}
	if (destination.body.includes(webhookUrlApplyPlaceholder)) sites.push('body')
	return sites
}

function describeAuth(destination: {
	secretName: string | null
	integration: string | null
	headers: Record<string, string>
}) {
	if (destination.secretName) return `secretName=${destination.secretName}`
	if (destination.integration) return `integration=${destination.integration}`
	const authorizationHeader = Object.entries(destination.headers).find(
		([name]) => name.toLowerCase() === 'authorization',
	)
	if (authorizationHeader) {
		return `header:${authorizationHeader[0]} (caller-supplied)`
	}
	return 'none'
}

export function toHttpApplyDestinationSnapshot(
	destination: WebhookUrlApplyHttpDestination,
): HttpApplyDestinationSnapshot {
	const method = normalizeHttpMethod(destination.method)
	const url = destination.url.trim()
	const headersRecord = destination.headers ?? {}
	const body = destination.body ?? ''
	const secretName = destination.secretName?.trim() || null
	const integration = destination.integration?.trim() || null
	const headers = Object.entries(headersRecord)
		.map(([name, value]) => ({ name, value }))
		.sort((left, right) => {
			const byLower = left.name
				.toLowerCase()
				.localeCompare(right.name.toLowerCase())
			if (byLower !== 0) return byLower
			return left.name.localeCompare(right.name)
		})
	return {
		method,
		url,
		headers,
		body,
		secretName,
		integration,
		injectionSites: listInjectionSites({
			url,
			headers: headersRecord,
			body,
		}),
		auth: describeAuth({
			secretName,
			integration,
			headers: headersRecord,
		}),
	}
}

export async function fingerprintHttpApplyDestination(
	destination: WebhookUrlApplyHttpDestination,
) {
	const snapshot = toHttpApplyDestinationSnapshot(destination)
	const material = JSON.stringify({
		method: snapshot.method,
		url: snapshot.url,
		headers: snapshot.headers,
		body: snapshot.body,
		secretName: snapshot.secretName,
		integration: snapshot.integration,
	})
	return sha256Hex(material)
}

export function buildWebhookApplyDestinationApprovalUrl(input: {
	baseUrl: string
	handle: string
	fingerprint: string
}) {
	const url = new URL(connectWebhookApplyPath, input.baseUrl)
	url.searchParams.set('handle', input.handle)
	url.searchParams.set('fingerprint', input.fingerprint)
	return url.toString()
}

export function buildWebhookApplyDestinationApprovalRequiredMessage(input: {
	approvalUrl: string
	destination: HttpApplyDestinationSnapshot
}) {
	const headerLines = input.destination.headers.map(
		(header) => `${header.name}=${header.value}`,
	)
	return [
		'HTTP webhookUrlApply requires owner approval for this outbound registration (prompt-injection / confused-deputy protection). This uses the same account approval flow as secret host approval (/connect/secrets), secret package grants, and locked-package publish approval: send the owner the approval_url, wait for them to Allow on the website, then retry. Agents cannot grant access.',
		'',
		`approval_url: ${input.approvalUrl}`,
		`method: ${input.destination.method}`,
		`url: ${input.destination.url}`,
		`${webhookUrlApplyPlaceholder} injection sites: ${input.destination.injectionSites.join(', ') || '(none)'}`,
		`headers: ${headerLines.length > 0 ? headerLines.join('; ') : '(none)'}`,
		`body: ${input.destination.body.length > 0 ? input.destination.body : '(none)'}`,
		`auth: ${input.destination.auth}`,
	].join('\n')
}

async function readGrantRow(input: {
	db: D1Database
	userId: string
	endpointId: string
	fingerprint: string
}) {
	return input.db
		.prepare(
			`SELECT *
			FROM webhook_apply_destination_grants
			WHERE user_id = ? AND webhook_endpoint_id = ? AND destination_fingerprint = ?
			LIMIT 1`,
		)
		.bind(input.userId, input.endpointId, input.fingerprint)
		.first<PendingOrGrantRow>()
}

async function readPendingRow(input: {
	db: D1Database
	userId: string
	endpointId: string
	fingerprint: string
}) {
	return input.db
		.prepare(
			`SELECT *
			FROM webhook_apply_destination_pending
			WHERE user_id = ? AND webhook_endpoint_id = ? AND destination_fingerprint = ?
			LIMIT 1`,
		)
		.bind(input.userId, input.endpointId, input.fingerprint)
		.first<PendingOrGrantRow>()
}

export async function hasWebhookApplyDestinationGrant(input: {
	db: D1Database
	userId: string
	endpointId: string
	fingerprint: string
}) {
	const row = await readGrantRow(input)
	return row != null
}

export async function upsertWebhookApplyDestinationPending(input: {
	db: D1Database
	userId: string
	endpointId: string
	fingerprint: string
	destination: HttpApplyDestinationSnapshot
	packageId: string
	webhookName: string
	now?: string
}) {
	const now = input.now ?? new Date().toISOString()
	const destinationJson = JSON.stringify(input.destination)
	await input.db
		.prepare(
			`INSERT INTO webhook_apply_destination_pending (
				user_id,
				webhook_endpoint_id,
				destination_fingerprint,
				destination_json,
				package_id,
				webhook_name,
				created_at,
				updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(user_id, webhook_endpoint_id, destination_fingerprint) DO UPDATE SET
				destination_json = excluded.destination_json,
				package_id = excluded.package_id,
				webhook_name = excluded.webhook_name,
				updated_at = excluded.updated_at`,
		)
		.bind(
			input.userId,
			input.endpointId,
			input.fingerprint,
			destinationJson,
			input.packageId,
			input.webhookName,
			now,
			now,
		)
		.run()
}

export async function approveWebhookApplyDestination(input: {
	db: D1Database
	userId: string
	endpointId: string
	fingerprint: string
	now?: string
}) {
	const pending = await readPendingRow(input)
	if (!pending) {
		const existing = await readGrantRow(input)
		if (existing) return { status: 'already_granted' as const }
		throw new Error(
			'No pending webhook apply destination matches this approval link.',
		)
	}
	const now = input.now ?? new Date().toISOString()
	await input.db.batch([
		input.db
			.prepare(
				`INSERT INTO webhook_apply_destination_grants (
					user_id,
					webhook_endpoint_id,
					destination_fingerprint,
					destination_json,
					package_id,
					webhook_name,
					approved_at
				) VALUES (?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(user_id, webhook_endpoint_id, destination_fingerprint) DO UPDATE SET
					destination_json = excluded.destination_json,
					package_id = excluded.package_id,
					webhook_name = excluded.webhook_name,
					approved_at = excluded.approved_at`,
			)
			.bind(
				input.userId,
				input.endpointId,
				input.fingerprint,
				pending.destination_json,
				pending.package_id,
				pending.webhook_name,
				now,
			),
		input.db
			.prepare(
				`DELETE FROM webhook_apply_destination_pending
				WHERE user_id = ? AND webhook_endpoint_id = ? AND destination_fingerprint = ?`,
			)
			.bind(input.userId, input.endpointId, input.fingerprint),
	])
	return { status: 'approved' as const }
}

export async function rejectWebhookApplyDestination(input: {
	db: D1Database
	userId: string
	endpointId: string
	fingerprint: string
}) {
	await input.db
		.prepare(
			`DELETE FROM webhook_apply_destination_pending
			WHERE user_id = ? AND webhook_endpoint_id = ? AND destination_fingerprint = ?`,
		)
		.bind(input.userId, input.endpointId, input.fingerprint)
		.run()
	return { status: 'rejected' as const }
}

function parseDestinationJson(raw: string): HttpApplyDestinationSnapshot {
	const parsed = JSON.parse(raw) as HttpApplyDestinationSnapshot
	if (
		typeof parsed !== 'object' ||
		parsed == null ||
		typeof parsed.method !== 'string' ||
		typeof parsed.url !== 'string'
	) {
		throw new Error('Stored webhook apply destination is invalid.')
	}
	return parsed
}

export async function loadWebhookApplyDestinationApprovalView(input: {
	db: D1Database
	userId: string
	handle: string
	fingerprint: string
}): Promise<WebhookApplyDestinationApprovalView | null> {
	const endpointId = parseWebhookUrlHandle(input.handle)
	if (!endpointId) return null
	const endpoint = await getWebhookEndpointByIdForUser({
		db: input.db,
		userId: input.userId,
		endpointId,
	})
	if (!endpoint) return null

	const grant = await readGrantRow({
		db: input.db,
		userId: input.userId,
		endpointId,
		fingerprint: input.fingerprint,
	})
	const pending =
		grant == null
			? await readPendingRow({
					db: input.db,
					userId: input.userId,
					endpointId,
					fingerprint: input.fingerprint,
				})
			: null
	const row = grant ?? pending
	if (!row) return null

	const savedPackage = await getSavedPackageById(input.db, {
		userId: input.userId,
		packageId: row.package_id,
	})
	if (!savedPackage) return null

	return {
		handle: formatWebhookUrlHandle(endpoint.id),
		fingerprint: input.fingerprint,
		packageId: savedPackage.id,
		packageKodyId: savedPackage.kodyId,
		packageName: savedPackage.name,
		webhookName: row.webhook_name,
		destination: parseDestinationJson(row.destination_json),
		alreadyGranted: grant != null,
	}
}

export async function requireWebhookApplyDestinationGrantOrPending(input: {
	db: D1Database
	userId: string
	handle: string
	destination: WebhookUrlApplyHttpDestination
	baseUrl: string
}): Promise<
	| { status: 'granted'; fingerprint: string }
	| {
			status: 'approval_required'
			fingerprint: string
			approvalUrl: string
			destination: HttpApplyDestinationSnapshot
			message: string
	  }
> {
	const endpointId = parseWebhookUrlHandle(input.handle)
	if (!endpointId) {
		throw new Error('Invalid webhook URL handle.')
	}
	const endpoint = await getWebhookEndpointByIdForUser({
		db: input.db,
		userId: input.userId,
		endpointId,
	})
	if (!endpoint) {
		throw new Error('Webhook handle was not found for this user.')
	}

	const snapshot = toHttpApplyDestinationSnapshot(input.destination)
	const fingerprint = await fingerprintHttpApplyDestination(input.destination)
	const granted = await hasWebhookApplyDestinationGrant({
		db: input.db,
		userId: input.userId,
		endpointId,
		fingerprint,
	})
	if (granted) {
		return { status: 'granted', fingerprint }
	}

	await upsertWebhookApplyDestinationPending({
		db: input.db,
		userId: input.userId,
		endpointId,
		fingerprint,
		destination: snapshot,
		packageId: endpoint.packageId,
		webhookName: endpoint.webhookName,
	})
	const approvalUrl = buildWebhookApplyDestinationApprovalUrl({
		baseUrl: input.baseUrl,
		handle: formatWebhookUrlHandle(endpoint.id),
		fingerprint,
	})
	return {
		status: 'approval_required',
		fingerprint,
		approvalUrl,
		destination: snapshot,
		message: buildWebhookApplyDestinationApprovalRequiredMessage({
			approvalUrl,
			destination: snapshot,
		}),
	}
}
