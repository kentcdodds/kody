/**
 * Exist-only Kit subscriber sync. Never creates Kit subscribers from account
 * events — waitlist joins stay on {@link subscribeToKitWaitlist}. Account
 * lifecycle only adds/removes tags when the email already exists in Kit.
 */

import { waitUntil } from 'cloudflare:workers'
import { parseStripePlanName } from '#universal/plans.ts'

const KIT_API_BASE_URL = 'https://api.kit.com/v4'
const DEFAULT_KIT_SIGNED_UP_TAG_ID = 21252175

class KitSyncError extends Error {
	readonly status: number | null
	readonly kind: 'client' | 'server' | 'network'

	constructor(
		message: string,
		options: { status?: number | null; kind: KitSyncError['kind'] },
	) {
		super(message)
		this.name = 'KitSyncError'
		this.status = options.status ?? null
		this.kind = options.kind
	}
}

function resolvePositiveIntId(
	raw: string | undefined,
	fallback: number,
): number | null {
	if (raw === undefined) return fallback
	const trimmed = raw.trim()
	if (!trimmed) return fallback
	if (!/^\d+$/.test(trimmed)) return null
	const parsed = Number.parseInt(trimmed, 10)
	if (!Number.isSafeInteger(parsed) || parsed <= 0) return null
	return parsed
}

function resolveKitSignedUpTagId(raw: string | undefined): number | null {
	return resolvePositiveIntId(raw, DEFAULT_KIT_SIGNED_UP_TAG_ID)
}

export const KIT_SYNC_REQUEST_TIMEOUT_MS = 8_000

export const kitLifecycleTagNames = {
	signedUp: 'signed_up::kody',
	verified: 'verified::kody',
	agentConnected: 'agent_connected::kody',
	activated: 'activated::kody',
	standard: 'standard::kody',
	pro: 'pro::kody',
} as const

export type KitLifecycleTagKey = keyof typeof kitLifecycleTagNames

export type KitSubscriberFacts = {
	signedUp: boolean
	verified: boolean
	agentConnected: boolean
	activated: boolean
	paidPlan: 'standard' | 'pro' | null
}

type KitTag = {
	id?: number
	name?: string
}

type KitJson = {
	subscriber?: { id?: number }
	subscribers?: Array<{ id?: number }>
	tags?: Array<KitTag>
	errors?: Array<string>
}

const kitSyncConcurrency = 4
export const kitSubscriberSyncSweepLimit = 80

function kitHeaders(apiKey: string): HeadersInit {
	return {
		Accept: 'application/json',
		'Content-Type': 'application/json',
		'X-Kit-Api-Key': apiKey,
	}
}

function isAbortError(error: unknown) {
	return (
		(error instanceof DOMException && error.name === 'TimeoutError') ||
		(error instanceof Error && error.name === 'AbortError')
	)
}

async function kitFetch(
	fetchImpl: typeof fetch,
	url: string,
	init: RequestInit,
	timeoutMs: number,
): Promise<Response> {
	try {
		return await fetchImpl(url, {
			...init,
			signal: AbortSignal.timeout(timeoutMs),
		})
	} catch (error) {
		if (isAbortError(error)) {
			throw new KitSyncError('Kit request timed out.', {
				status: null,
				kind: 'network',
			})
		}
		throw new KitSyncError('Kit request failed.', {
			status: null,
			kind: 'network',
		})
	}
}

async function readKitJson(response: Response): Promise<KitJson | null> {
	try {
		return (await response.json()) as KitJson
	} catch {
		return null
	}
}

function kitErrorMessage(payload: KitJson | null, fallback: string) {
	const first = payload?.errors?.[0]
	return typeof first === 'string' && first.trim() ? first : fallback
}

function classifyHttpKind(status: number): 'client' | 'server' {
	return status >= 500 ? 'server' : 'client'
}

function throwIfKitFailed(
	response: Response,
	payload: KitJson | null,
	fallback: string,
) {
	if (response.ok) return
	throw new KitSyncError(
		kitErrorMessage(payload, `${fallback} (${response.status}).`),
		{
			status: response.status,
			kind: classifyHttpKind(response.status),
		},
	)
}

export function kitFactsFromUserRow(row: {
	email_verified_at?: string | null
	first_mcp_connected_at?: string | null
	first_saved_package_at?: string | null
	stripe_plan?: string | null
}): KitSubscriberFacts {
	const stripePlan = parseStripePlanName(row.stripe_plan)
	const paidPlan =
		stripePlan === 'standard' || stripePlan === 'pro' ? stripePlan : null
	return {
		signedUp: true,
		verified: Boolean(row.email_verified_at),
		agentConnected: Boolean(row.first_mcp_connected_at),
		activated: Boolean(row.first_saved_package_at),
		paidPlan,
	}
}

export function desiredKitTagKeys(
	facts: KitSubscriberFacts,
): Array<KitLifecycleTagKey> {
	const keys: Array<KitLifecycleTagKey> = []
	if (facts.signedUp) keys.push('signedUp')
	if (facts.verified) keys.push('verified')
	if (facts.agentConnected) keys.push('agentConnected')
	if (facts.activated) keys.push('activated')
	if (facts.paidPlan === 'standard') keys.push('standard')
	if (facts.paidPlan === 'pro') keys.push('pro')
	return keys
}

async function lookupKitSubscriberId(input: {
	apiKey: string
	email: string
	fetchImpl: typeof fetch
	timeoutMs: number
}): Promise<number | null> {
	const response = await kitFetch(
		input.fetchImpl,
		`${KIT_API_BASE_URL}/subscribers?email_address=${encodeURIComponent(input.email)}`,
		{ method: 'GET', headers: kitHeaders(input.apiKey) },
		input.timeoutMs,
	)
	const payload = await readKitJson(response)
	throwIfKitFailed(response, payload, 'Kit subscriber lookup failed')
	const existing = payload?.subscribers?.find(
		(subscriber) => typeof subscriber.id === 'number',
	)
	return typeof existing?.id === 'number' ? existing.id : null
}

async function listKitTagsByName(input: {
	apiKey: string
	fetchImpl: typeof fetch
	timeoutMs: number
}): Promise<Map<string, number>> {
	const byName = new Map<string, number>()
	let after: string | null = null
	for (let page = 0; page < 10; page += 1) {
		const url = new URL(`${KIT_API_BASE_URL}/tags`)
		url.searchParams.set('per_page', '50')
		if (after) url.searchParams.set('after', after)
		const response = await kitFetch(
			input.fetchImpl,
			url.toString(),
			{ method: 'GET', headers: kitHeaders(input.apiKey) },
			input.timeoutMs,
		)
		const payload = await readKitJson(response)
		throwIfKitFailed(response, payload, 'Kit tag list failed')
		const tags = payload?.tags ?? []
		for (const tag of tags) {
			if (typeof tag.id === 'number' && typeof tag.name === 'string') {
				byName.set(tag.name, tag.id)
			}
		}
		if (tags.length < 50) break
		const lastId = tags.at(-1)?.id
		after = typeof lastId === 'number' ? String(lastId) : null
		if (!after) break
	}
	return byName
}

async function addKitTag(input: {
	apiKey: string
	email: string
	tagId: number
	fetchImpl: typeof fetch
	timeoutMs: number
}) {
	const response = await kitFetch(
		input.fetchImpl,
		`${KIT_API_BASE_URL}/tags/${input.tagId}/subscribers`,
		{
			method: 'POST',
			headers: kitHeaders(input.apiKey),
			body: JSON.stringify({ email_address: input.email }),
		},
		input.timeoutMs,
	)
	const payload = await readKitJson(response)
	throwIfKitFailed(response, payload, 'Kit tag add failed')
}

async function removeKitTag(input: {
	apiKey: string
	subscriberId: number
	tagId: number
	fetchImpl: typeof fetch
	timeoutMs: number
}) {
	const response = await kitFetch(
		input.fetchImpl,
		`${KIT_API_BASE_URL}/subscribers/${input.subscriberId}/tags/${input.tagId}`,
		{ method: 'DELETE', headers: kitHeaders(input.apiKey) },
		input.timeoutMs,
	)
	if (response.status === 404) return
	const payload = await readKitJson(response)
	throwIfKitFailed(response, payload, 'Kit tag remove failed')
}

export async function syncExistingKitSubscriber(input: {
	apiKey: string
	email: string
	facts: KitSubscriberFacts
	signedUpTagId?: number
	fetchImpl?: typeof fetch
	timeoutMs?: number
	tagNames?: Map<string, number>
}): Promise<
	| { synced: true; subscriberId: number }
	| { synced: false; reason: 'not_found' }
> {
	const fetchImpl = input.fetchImpl ?? fetch
	const timeoutMs = input.timeoutMs ?? KIT_SYNC_REQUEST_TIMEOUT_MS
	const subscriberId = await lookupKitSubscriberId({
		apiKey: input.apiKey,
		email: input.email,
		fetchImpl,
		timeoutMs,
	})
	if (subscriberId == null) {
		return { synced: false, reason: 'not_found' }
	}

	const tagNames =
		input.tagNames ??
		(await listKitTagsByName({
			apiKey: input.apiKey,
			fetchImpl,
			timeoutMs,
		}))
	const desired = new Set(desiredKitTagKeys(input.facts))
	const paidKeys: Array<KitLifecycleTagKey> = ['standard', 'pro']

	for (const key of Object.keys(
		kitLifecycleTagNames,
	) as Array<KitLifecycleTagKey>) {
		const name = kitLifecycleTagNames[key]
		const tagId =
			key === 'signedUp'
				? (input.signedUpTagId ??
					tagNames.get(name) ??
					DEFAULT_KIT_SIGNED_UP_TAG_ID)
				: tagNames.get(name)
		if (tagId == null) {
			if (desired.has(key) || paidKeys.includes(key)) {
				console.warn(`Skipping Kit tag ${name}: tag is missing in Kit.`)
			}
			continue
		}
		if (desired.has(key)) {
			await addKitTag({
				apiKey: input.apiKey,
				email: input.email,
				tagId,
				fetchImpl,
				timeoutMs,
			})
			continue
		}
		if (paidKeys.includes(key)) {
			await removeKitTag({
				apiKey: input.apiKey,
				subscriberId,
				tagId,
				fetchImpl,
				timeoutMs,
			})
		}
	}

	return { synced: true, subscriberId }
}

export function resolveKitApiKey(env: Pick<Env, 'KIT_API_KEY'>): string | null {
	const apiKey = env.KIT_API_KEY?.trim()
	return apiKey || null
}

export async function maybeSyncKitSubscriber(input: {
	env: Pick<Env, 'KIT_API_KEY' | 'KIT_SIGNED_UP_TAG_ID'>
	email: string
	facts: KitSubscriberFacts
	fetchImpl?: typeof fetch
	tagNames?: Map<string, number>
}): Promise<void> {
	const apiKey = resolveKitApiKey(input.env)
	if (!apiKey) return
	const tagId = resolveKitSignedUpTagId(input.env.KIT_SIGNED_UP_TAG_ID)
	if (tagId === null) {
		console.warn(
			'Skipping Kit subscriber sync: KIT_SIGNED_UP_TAG_ID is invalid.',
		)
		return
	}
	try {
		await syncExistingKitSubscriber({
			apiKey,
			email: input.email,
			facts: input.facts,
			signedUpTagId: tagId,
			fetchImpl: input.fetchImpl,
			tagNames: input.tagNames,
		})
	} catch (error) {
		console.warn('Failed to sync Kit subscriber:', error)
	}
}

type KitUserRow = {
	email: string
	email_verified_at: string | null
	first_mcp_connected_at: string | null
	first_saved_package_at: string | null
	stripe_plan: string | null
}

export async function maybeSyncKitSubscriberForUser(input: {
	env: Pick<Env, 'APP_DB' | 'KIT_API_KEY' | 'KIT_SIGNED_UP_TAG_ID'>
	email?: string | null
	stableUserId?: string | null
	fetchImpl?: typeof fetch
	tagNames?: Map<string, number>
}): Promise<void> {
	const email = input.email?.trim()
	const stableUserId = input.stableUserId?.trim()
	if (!email && !stableUserId) return
	const row = email
		? await input.env.APP_DB.prepare(
				`SELECT email, email_verified_at, first_mcp_connected_at,
				        first_saved_package_at, stripe_plan
				 FROM users
				 WHERE email = ? AND deleting_at IS NULL
				 LIMIT 1`,
			)
				.bind(email)
				.first<KitUserRow>()
		: await input.env.APP_DB.prepare(
				`SELECT email, email_verified_at, first_mcp_connected_at,
				        first_saved_package_at, stripe_plan
				 FROM users
				 WHERE stable_user_id = ? AND deleting_at IS NULL
				 LIMIT 1`,
			)
				.bind(stableUserId)
				.first<KitUserRow>()
	if (!row?.email) return
	await maybeSyncKitSubscriber({
		env: input.env,
		email: row.email,
		facts: kitFactsFromUserRow(row),
		fetchImpl: input.fetchImpl,
		tagNames: input.tagNames,
	})
}

export function scheduleKitSubscriberSync(input: {
	env: Pick<Env, 'APP_DB' | 'KIT_API_KEY' | 'KIT_SIGNED_UP_TAG_ID'>
	email?: string | null
	stableUserId?: string | null
}) {
	if (!resolveKitApiKey(input.env)) return
	waitUntil(
		maybeSyncKitSubscriberForUser(input).catch((error) => {
			console.warn('Failed to sync Kit subscriber:', error)
		}),
	)
}

async function mapWithConcurrency<T>(
	items: ReadonlyArray<T>,
	concurrency: number,
	mapper: (item: T) => Promise<void>,
): Promise<void> {
	if (items.length === 0) return
	const limit = Math.max(1, Math.min(concurrency, items.length))
	let nextIndex = 0
	await Promise.all(
		Array.from({ length: limit }, async () => {
			while (nextIndex < items.length) {
				const index = nextIndex
				nextIndex += 1
				const item = items[index]
				if (item === undefined) return
				await mapper(item)
			}
		}),
	)
}

export type KitSubscriberReconcileResult =
	| { status: 'skipped'; reason: 'no_api_key' }
	| { status: 'synced'; considered: number; tagged: number }

export async function reconcileKitSubscribers(input: {
	env: Env
	now?: Date
	fetchImpl?: typeof fetch
}): Promise<KitSubscriberReconcileResult> {
	const apiKey = resolveKitApiKey(input.env)
	if (!apiKey) return { status: 'skipped', reason: 'no_api_key' }
	const tagId = resolveKitSignedUpTagId(input.env.KIT_SIGNED_UP_TAG_ID)
	if (tagId === null) {
		console.warn(
			'Skipping Kit subscriber reconcile: KIT_SIGNED_UP_TAG_ID is invalid.',
		)
		return { status: 'skipped', reason: 'no_api_key' }
	}

	const users = await input.env.APP_DB.prepare(
		`SELECT email, email_verified_at, first_mcp_connected_at,
		        first_saved_package_at, stripe_plan
		 FROM users
		 WHERE deleting_at IS NULL
		   AND account_type = 'person'
		   AND email IS NOT NULL
		 ORDER BY updated_at DESC
		 LIMIT ?`,
	)
		.bind(kitSubscriberSyncSweepLimit)
		.all<KitUserRow>()

	const rows = users.results ?? []
	if (rows.length === 0) {
		return { status: 'synced', considered: 0, tagged: 0 }
	}

	const fetchImpl = input.fetchImpl ?? fetch
	let tagNames: Map<string, number>
	try {
		tagNames = await listKitTagsByName({
			apiKey,
			fetchImpl,
			timeoutMs: KIT_SYNC_REQUEST_TIMEOUT_MS,
		})
	} catch (error) {
		console.warn('Failed to list Kit tags for reconcile:', error)
		return { status: 'synced', considered: 0, tagged: 0 }
	}

	let tagged = 0
	await mapWithConcurrency(rows, kitSyncConcurrency, async (row) => {
		try {
			const result = await syncExistingKitSubscriber({
				apiKey,
				email: row.email,
				facts: kitFactsFromUserRow(row),
				signedUpTagId: tagId,
				fetchImpl,
				tagNames,
			})
			if (result.synced) tagged += 1
		} catch (error) {
			console.warn('Failed to reconcile Kit subscriber:', error)
		}
	})
	return { status: 'synced', considered: rows.length, tagged }
}
