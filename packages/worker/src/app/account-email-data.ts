import { type readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	emailVerificationRequiredMessage,
	isAccountEmailVerified,
} from '#app/email-verification.ts'
import { readPagination } from '#worker/query-params.ts'
import { toMessageDetail } from '#mcp/capabilities/email/shared.ts'
import {
	resolveEmailResourceLimit,
	type PlanName,
} from '#worker/entitlements/plans.ts'
import {
	getUserPlan,
	readEntitlementResourceUsage,
} from '#worker/entitlements/service.ts'
import {
	buildPlatformEmailAddress,
	getPlatformEmailDomain,
} from '#worker/email/platform-address.ts'
import {
	getEmailMessageById,
	listEmailAttachmentsForMessage,
	listEmailDeliveryEvents,
	listEmailInboxAddressesForUser,
	listEmailInboxesForUser,
} from '#worker/email/repo.ts'
import {
	emailClassificationValues,
	emailDeliveryStatusValues,
	emailDirectionValues,
	emailProcessingStatusValues,
	type EmailClassification,
	type EmailDeliveryStatus,
	type EmailDirection,
	type EmailProcessingStatus,
} from '#worker/email/types.ts'
import { utcDayKey } from '@kody-internal/shared/date-keys.ts'

type AuthenticatedUser = NonNullable<
	Awaited<ReturnType<typeof readAuthenticatedAppUser>>
>

const accountEmailBasePath = '/account/email'
const defaultPageSize = 25
const maxPageSize = 100
const deliveryEventsLimit = 25

export type AccountEmailUsageEntry = {
	count: number
	limit: number
}

export type AccountEmailUsage = {
	plan: PlanName
	day: string
	stored_messages: AccountEmailUsageEntry
	sends_today: AccountEmailUsageEntry
	receives_today: AccountEmailUsageEntry
	max_message_bytes: number
}

export type AccountEmailInboxAddress = {
	id: string
	address: string
	enabled: boolean
	created_at: string
}

export type AccountEmailInbox = {
	id: string
	name: string
	description: string
	enabled: boolean
	addresses: Array<AccountEmailInboxAddress>
	created_at: string
	updated_at: string
}

export type AccountEmailMessageListItem = {
	id: string
	direction: EmailDirection
	inbox_id: string | null
	thread_id: string | null
	from_address: string | null
	envelope_from: string | null
	to_addresses: Array<string>
	subject: string | null
	message_id_header: string | null
	processing_status: EmailProcessingStatus
	classification: EmailClassification
	classification_reason: string | null
	provider_message_id: string | null
	delivery_status: EmailDeliveryStatus | null
	delivery_status_at: string | null
	error: string | null
	received_at: string | null
	sent_at: string | null
	created_at: string
	updated_at: string
}

export type AccountEmailAttachment = {
	id: string
	filename: string | null
	content_type: string | null
	content_id: string | null
	disposition: string | null
	size: number | null
	storage_kind: string
	storage_key: string | null
	created_at: string
}

export type AccountEmailDeliveryEvent = {
	id: string
	event_type: string
	provider: string | null
	provider_message_id: string | null
	provider_event_id: string | null
	detail_json: string
	created_at: string
}

export type AccountEmailMessageDetail = AccountEmailMessageListItem & {
	cc_addresses: Array<string>
	bcc_addresses: Array<string>
	reply_to_addresses: Array<string>
	in_reply_to_header: string | null
	references: Array<string>
	headers: Record<string, unknown> | null
	auth_results: string | null
	text_body: string | null
	html_body: string | null
	raw_size: number | null
	attachments: Array<AccountEmailAttachment>
	delivery_events: Array<AccountEmailDeliveryEvent>
}

/**
 * Loader payload for `/account/email`. Types live here until the integrator
 * adds `accountEmail` to `AppLoaderData`.
 */
export type AccountEmailLoaderData = {
	ok: true
	emailVerified: boolean
	email: string
	username: string
	/** Platform-assigned `{username}@<platform domain>` when configured. */
	inboxAddress: string | null
	verificationMessage: string | null
	inboxes: Array<AccountEmailInbox>
	messages: Array<AccountEmailMessageListItem>
	selectedMessage: AccountEmailMessageDetail | null
	usage: AccountEmailUsage | null
	page: number
	pageSize: number
	total: number
	query: string
	/** `null` means no classification filter (all messages). */
	classification: EmailClassification | null
}

export function readAccountEmailSelectedMessageId(
	requestUrl: string,
	pathMessageId?: string,
) {
	if (pathMessageId?.trim()) return pathMessageId.trim()
	const url = new URL(requestUrl, 'http://localhost')
	const detailPrefix = `${accountEmailBasePath}/`
	if (url.pathname.startsWith(detailPrefix)) {
		const segment = url.pathname.slice(detailPrefix.length)
		if (segment && !segment.includes('/')) {
			try {
				const messageId = decodeURIComponent(segment)
				if (messageId) return messageId
			} catch {
				if (segment) return segment
			}
		}
	}
	return url.searchParams.get('selected')?.trim() || null
}

/** Escape LIKE wildcards so user queries match literally. */
function escapeLikePattern(value: string) {
	return value.replaceAll(/[\\%_]/g, (character) => `\\${character}`)
}

function parseDirection(value: unknown): EmailDirection {
	const raw = String(value)
	return (emailDirectionValues as ReadonlyArray<string>).includes(raw)
		? (raw as EmailDirection)
		: 'inbound'
}

function parseProcessingStatus(value: unknown): EmailProcessingStatus {
	const raw = String(value)
	return (emailProcessingStatusValues as ReadonlyArray<string>).includes(raw)
		? (raw as EmailProcessingStatus)
		: 'stored'
}

function parseDeliveryStatus(value: unknown): EmailDeliveryStatus | null {
	if (value == null) return null
	const raw = String(value)
	return (emailDeliveryStatusValues as ReadonlyArray<string>).includes(raw)
		? (raw as EmailDeliveryStatus)
		: null
}

function parseClassification(value: unknown): EmailClassification {
	if (value == null) return 'accepted'
	const raw = String(value)
	return (emailClassificationValues as ReadonlyArray<string>).includes(raw)
		? (raw as EmailClassification)
		: 'accepted'
}

export function readAccountEmailClassificationFilter(
	requestUrl: string,
): EmailClassification | null {
	const url = new URL(requestUrl, 'http://localhost')
	const raw = url.searchParams.get('classification')?.trim() ?? ''
	return (emailClassificationValues as ReadonlyArray<string>).includes(raw)
		? (raw as EmailClassification)
		: null
}

function parseJsonStringArray(value: unknown): Array<string> {
	if (typeof value !== 'string' || !value) return []
	try {
		const parsed = JSON.parse(value) as unknown
		return Array.isArray(parsed)
			? parsed.filter((entry): entry is string => typeof entry === 'string')
			: []
	} catch {
		return []
	}
}

function rowToListItem(
	row: Record<string, unknown>,
): AccountEmailMessageListItem {
	return {
		id: String(row['id']),
		direction: parseDirection(row['direction']),
		inbox_id: row['inbox_id'] == null ? null : String(row['inbox_id']),
		thread_id: row['thread_id'] == null ? null : String(row['thread_id']),
		from_address:
			row['from_address'] == null ? null : String(row['from_address']),
		envelope_from:
			row['envelope_from'] == null ? null : String(row['envelope_from']),
		to_addresses: parseJsonStringArray(row['to_addresses_json']),
		subject: row['subject'] == null ? null : String(row['subject']),
		message_id_header:
			row['message_id_header'] == null
				? null
				: String(row['message_id_header']),
		processing_status: parseProcessingStatus(row['processing_status']),
		classification: parseClassification(row['classification']),
		classification_reason:
			row['classification_reason'] == null
				? null
				: String(row['classification_reason']),
		provider_message_id:
			row['provider_message_id'] == null
				? null
				: String(row['provider_message_id']),
		delivery_status: parseDeliveryStatus(row['delivery_status']),
		delivery_status_at:
			row['delivery_status_at'] == null
				? null
				: String(row['delivery_status_at']),
		error: row['error'] == null ? null : String(row['error']),
		received_at: row['received_at'] == null ? null : String(row['received_at']),
		sent_at: row['sent_at'] == null ? null : String(row['sent_at']),
		created_at: String(row['created_at']),
		updated_at: String(row['updated_at']),
	}
}

async function countAndListMessages(input: {
	db: D1Database
	userId: string
	query: string
	classification: EmailClassification | null
	pageSize: number
	offset: number
}) {
	const classification = input.classification
	if (input.query) {
		const pattern = `%${escapeLikePattern(input.query.toLowerCase())}%`
		const [totalResult, messageRows] = await Promise.all([
			input.db
				.prepare(
					`SELECT COUNT(*) AS total
					FROM email_messages
					WHERE user_id = ?
						AND (? IS NULL OR classification = ?)
						AND (
							LOWER(subject) LIKE ? ESCAPE '\\'
							OR LOWER(from_address) LIKE ? ESCAPE '\\'
							OR LOWER(COALESCE(envelope_from, '')) LIKE ? ESCAPE '\\'
						)`,
				)
				.bind(
					input.userId,
					classification,
					classification,
					pattern,
					pattern,
					pattern,
				)
				.first<{ total: number }>(),
			input.db
				.prepare(
					`SELECT *
					FROM email_messages
					WHERE user_id = ?
						AND (? IS NULL OR classification = ?)
						AND (
							LOWER(subject) LIKE ? ESCAPE '\\'
							OR LOWER(from_address) LIKE ? ESCAPE '\\'
							OR LOWER(COALESCE(envelope_from, '')) LIKE ? ESCAPE '\\'
						)
					ORDER BY created_at DESC, id DESC
					LIMIT ? OFFSET ?`,
				)
				.bind(
					input.userId,
					classification,
					classification,
					pattern,
					pattern,
					pattern,
					input.pageSize,
					input.offset,
				)
				.all<Record<string, unknown>>(),
		])
		return {
			total: Number(totalResult?.total ?? 0),
			messages: (messageRows.results ?? []).map(rowToListItem),
		}
	}

	const [totalResult, messageRows] = await Promise.all([
		input.db
			.prepare(
				`SELECT COUNT(*) AS total
				FROM email_messages
				WHERE user_id = ?
					AND (? IS NULL OR classification = ?)`,
			)
			.bind(input.userId, classification, classification)
			.first<{ total: number }>(),
		input.db
			.prepare(
				`SELECT *
				FROM email_messages
				WHERE user_id = ?
					AND (? IS NULL OR classification = ?)
				ORDER BY created_at DESC, id DESC
				LIMIT ? OFFSET ?`,
			)
			.bind(
				input.userId,
				classification,
				classification,
				input.pageSize,
				input.offset,
			)
			.all<Record<string, unknown>>(),
	])
	return {
		total: Number(totalResult?.total ?? 0),
		messages: (messageRows.results ?? []).map(rowToListItem),
	}
}

async function loadUsage(input: {
	db: D1Database
	userId: string
	email: string
}): Promise<AccountEmailUsage> {
	const now = new Date()
	const plan: PlanName = await getUserPlan(input.db, {
		userId: input.userId,
		email: input.email,
	})
	const [storedMessages, sendsToday, receivesToday] = await Promise.all([
		readEntitlementResourceUsage({
			db: input.db,
			userId: input.userId,
			resource: 'stored_email_messages',
			now,
		}),
		readEntitlementResourceUsage({
			db: input.db,
			userId: input.userId,
			resource: 'email_sends_per_day',
			now,
		}),
		readEntitlementResourceUsage({
			db: input.db,
			userId: input.userId,
			resource: 'email_receives_per_day',
			now,
		}),
	])
	return {
		plan,
		day: utcDayKey(now),
		stored_messages: {
			count: storedMessages,
			limit: resolveEmailResourceLimit(plan, 'stored_email_messages'),
		},
		sends_today: {
			count: sendsToday,
			limit: resolveEmailResourceLimit(plan, 'email_sends_per_day'),
		},
		receives_today: {
			count: receivesToday,
			limit: resolveEmailResourceLimit(plan, 'email_receives_per_day'),
		},
		max_message_bytes: resolveEmailResourceLimit(plan, 'email_message_bytes'),
	}
}

async function loadInboxes(input: {
	db: D1Database
	userId: string
}): Promise<Array<AccountEmailInbox>> {
	const [inboxes, addresses] = await Promise.all([
		listEmailInboxesForUser(input),
		listEmailInboxAddressesForUser(input),
	])
	return inboxes.map((inbox) => ({
		id: inbox.id,
		name: inbox.name,
		description: inbox.description,
		enabled: inbox.enabled,
		addresses: addresses
			.filter((address) => address.inboxId === inbox.id)
			.map((address) => ({
				id: address.id,
				address: address.address,
				enabled: address.enabled,
				created_at: address.createdAt,
			})),
		created_at: inbox.createdAt,
		updated_at: inbox.updatedAt,
	}))
}

async function loadSelectedMessage(input: {
	db: D1Database
	userId: string
	messageId: string
}): Promise<AccountEmailMessageDetail | null> {
	const message = await getEmailMessageById({
		db: input.db,
		userId: input.userId,
		messageId: input.messageId,
	})
	if (!message) return null
	const [attachments, deliveryEvents] = await Promise.all([
		listEmailAttachmentsForMessage({
			db: input.db,
			messageId: message.id,
		}),
		listEmailDeliveryEvents({
			db: input.db,
			userId: input.userId,
			messageId: message.id,
			limit: deliveryEventsLimit,
		}),
	])
	const detail = toMessageDetail(message, attachments)
	return {
		...detail,
		classification: message.classification,
		classification_reason: message.classificationReason,
		delivery_events: deliveryEvents.map((event) => ({
			id: event.id,
			event_type: event.eventType,
			provider: event.provider,
			provider_message_id: event.providerMessageId,
			provider_event_id: event.providerEventId,
			detail_json: event.detailJson,
			created_at: event.createdAt,
		})),
	}
}

function resolveInboxAddress(input: {
	env: Env
	username: string
}): string | null {
	const domain = getPlatformEmailDomain(input.env)
	if (!domain || !input.username.trim()) return null
	return buildPlatformEmailAddress({
		username: input.username,
		domain,
	})
}

function emptyVerifiedShell(input: {
	user: AuthenticatedUser
	env: Env
	page: number
	pageSize: number
	query: string
	classification: EmailClassification | null
	emailVerified: boolean
}): AccountEmailLoaderData {
	return {
		ok: true,
		emailVerified: input.emailVerified,
		email: input.user.email,
		username: input.user.username,
		inboxAddress: resolveInboxAddress({
			env: input.env,
			username: input.user.username,
		}),
		verificationMessage: input.emailVerified
			? null
			: emailVerificationRequiredMessage,
		inboxes: [],
		messages: [],
		selectedMessage: null,
		usage: null,
		page: input.page,
		pageSize: input.pageSize,
		total: 0,
		query: input.query,
		classification: input.classification,
	}
}

export async function loadAccountEmailData(input: {
	env: Env
	request: Request
	user: AuthenticatedUser
	pathMessageId?: string
}): Promise<AccountEmailLoaderData> {
	const url = new URL(input.request.url, 'http://localhost')
	const { page, pageSize, offset } = readPagination(url, {
		defaultPageSize,
		maxPageSize,
	})
	const query = url.searchParams.get('q')?.trim() ?? ''
	const classification = readAccountEmailClassificationFilter(input.request.url)
	const userId = input.user.mcpUser.userId
	const emailVerified =
		input.user.emailVerified ||
		(await isAccountEmailVerified({
			db: input.env.APP_DB,
			email: input.user.email,
			stableUserId: userId,
		}))

	if (!emailVerified) {
		return emptyVerifiedShell({
			user: input.user,
			env: input.env,
			page,
			pageSize,
			query,
			classification,
			emailVerified: false,
		})
	}

	const selectedMessageId = readAccountEmailSelectedMessageId(
		input.request.url,
		input.pathMessageId,
	)

	const [listResult, inboxes, usage, selectedMessage] = await Promise.all([
		countAndListMessages({
			db: input.env.APP_DB,
			userId,
			query,
			classification,
			pageSize,
			offset,
		}),
		loadInboxes({ db: input.env.APP_DB, userId }),
		loadUsage({
			db: input.env.APP_DB,
			userId,
			email: input.user.email,
		}),
		selectedMessageId
			? loadSelectedMessage({
					db: input.env.APP_DB,
					userId,
					messageId: selectedMessageId,
				})
			: Promise.resolve(null),
	])

	return {
		ok: true,
		emailVerified: true,
		email: input.user.email,
		username: input.user.username,
		inboxAddress: resolveInboxAddress({
			env: input.env,
			username: input.user.username,
		}),
		verificationMessage: null,
		inboxes,
		messages: listResult.messages,
		selectedMessage,
		usage,
		page,
		pageSize,
		total: listResult.total,
		query,
		classification,
	}
}
