import { utcDayKey } from '@kody-internal/shared/date-keys.ts'
import { type readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	emailVerificationRequiredMessage,
	isAccountEmailVerified,
} from '#app/email-verification.ts'
import { hasResolvedRequestFeatureFlags } from '#app/request-feature-flags-cache.ts'
import { toMessageDetail } from '#mcp/capabilities/email/shared.ts'
import {
	getOwnerEmailMessageById,
	listOwnerEmailAttachmentsForMessage,
	listOwnerEmailDeliveryEvents,
	listOwnerEmailMessagesPage,
	type MailboxReadCutoverMemo,
} from '#worker/email/mailbox-read-cutover.ts'
import {
	buildPlatformEmailAddress,
	getPlatformEmailDomain,
} from '#worker/email/platform-address.ts'
import {
	listEmailInboxAddressesForUser,
	listEmailInboxesForUser,
} from '#worker/email/repo.ts'
import {
	emailClassificationValues,
	type EmailClassification,
	type EmailDeliveryStatus,
	type EmailDirection,
	type EmailMessageRecord,
	type EmailProcessingStatus,
} from '#worker/email/types.ts'
import {
	resolveEmailResourceLimit,
	type PlanName,
} from '#worker/entitlements/plans.ts'
import {
	getUserPlan,
	readCurrentEntitlementResourceUsage,
	readDailyEntitlementResourceUsage,
	type EntitlementUsageEnv,
} from '#worker/entitlements/service.ts'
import { readPagination } from '#worker/query-params.ts'

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

export function readAccountEmailClassificationFilter(
	requestUrl: string,
): EmailClassification | null {
	const url = new URL(requestUrl, 'http://localhost')
	const raw = url.searchParams.get('classification')?.trim() ?? ''
	return (emailClassificationValues as ReadonlyArray<string>).includes(raw)
		? (raw as EmailClassification)
		: null
}

function asStringAddresses(value: Array<unknown>): Array<string> {
	return value.filter((entry): entry is string => typeof entry === 'string')
}

function messageToListItem(
	message: EmailMessageRecord,
): AccountEmailMessageListItem {
	return {
		id: message.id,
		direction: message.direction,
		inbox_id: message.inboxId,
		thread_id: message.threadId,
		from_address: message.fromAddress,
		envelope_from: message.envelopeFrom,
		to_addresses: asStringAddresses(message.toAddresses),
		subject: message.subject,
		message_id_header: message.messageIdHeader,
		processing_status: message.processingStatus,
		classification: message.classification,
		classification_reason: message.classificationReason,
		provider_message_id: message.providerMessageId,
		delivery_status: message.deliveryStatus,
		delivery_status_at: message.deliveryStatusAt,
		error: message.error,
		received_at: message.receivedAt,
		sent_at: message.sentAt,
		created_at: message.createdAt,
		updated_at: message.updatedAt,
	}
}

async function loadUsage(input: {
	db: D1Database
	env: EntitlementUsageEnv
	userId: string
	email: string
}): Promise<AccountEmailUsage> {
	const now = new Date()
	const plan: PlanName = await getUserPlan(input.db, {
		userId: input.userId,
		email: input.email,
	})
	const [storedMessages, sendsToday, receivesToday] = await Promise.all([
		readCurrentEntitlementResourceUsage({
			db: input.db,
			env: input.env,
			userId: input.userId,
			resource: 'stored_email_messages',
			now,
		}),
		readDailyEntitlementResourceUsage({
			db: input.db,
			env: input.env,
			userId: input.userId,
			resource: 'email_sends_per_day',
			now,
		}),
		readDailyEntitlementResourceUsage({
			db: input.db,
			env: input.env,
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
	env: Env
	dbUserId: number
	stableUserId: string
	messageId: string
	skipExposureRecording: boolean
	memo: MailboxReadCutoverMemo
}): Promise<AccountEmailMessageDetail | null> {
	const message = await getOwnerEmailMessageById({
		env: input.env,
		dbUserId: input.dbUserId,
		stableUserId: input.stableUserId,
		messageId: input.messageId,
		skipExposureRecording: input.skipExposureRecording,
		memo: input.memo,
	})
	if (!message) return null
	const [attachments, deliveryEvents] = await Promise.all([
		listOwnerEmailAttachmentsForMessage({
			env: input.env,
			dbUserId: input.dbUserId,
			stableUserId: input.stableUserId,
			messageId: message.id,
			skipExposureRecording: input.skipExposureRecording,
			memo: input.memo,
		}),
		listOwnerEmailDeliveryEvents({
			env: input.env,
			dbUserId: input.dbUserId,
			stableUserId: input.stableUserId,
			messageId: message.id,
			limit: deliveryEventsLimit,
			skipExposureRecording: input.skipExposureRecording,
			memo: input.memo,
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
	/**
	 * SSR account pages resolve feature flags (and record exposures) in
	 * `renderAppPage` / session load. Skip cutover exposure here to avoid
	 * double-recording on the same request.
	 */
	skipCutoverExposureRecording?: boolean
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
	const cutoverMemo: MailboxReadCutoverMemo = {}
	const dbUserId = input.user.userId
	const skipExposureRecording =
		input.skipCutoverExposureRecording === true ||
		hasResolvedRequestFeatureFlags(input.request)

	const [listResult, inboxes, usage, selectedMessage] = await Promise.all([
		listOwnerEmailMessagesPage({
			env: input.env,
			dbUserId,
			stableUserId: userId,
			query,
			classification,
			pageSize,
			offset,
			skipExposureRecording,
			memo: cutoverMemo,
		}),
		loadInboxes({ db: input.env.APP_DB, userId }),
		loadUsage({
			db: input.env.APP_DB,
			env: input.env,
			userId,
			email: input.user.email,
		}),
		selectedMessageId
			? loadSelectedMessage({
					env: input.env,
					dbUserId,
					stableUserId: userId,
					messageId: selectedMessageId,
					skipExposureRecording,
					memo: cutoverMemo,
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
		messages: listResult.messages.map(messageToListItem),
		selectedMessage,
		usage,
		page,
		pageSize,
		total: listResult.total,
		query,
		classification,
	}
}
