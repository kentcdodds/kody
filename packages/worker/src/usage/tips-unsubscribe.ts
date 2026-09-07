import {
	base64UrlToBytes,
	bytesToBase64Url,
	utf8ToBase64Url,
} from '@kody-internal/shared/base64.ts'

export const tipsUnsubscribePath = '/unsubscribe/tips'
export const tipsUnsubscribeLabel = 'Unsubscribe from tips'
export const tipsUnsubscribeOneClickBody = 'List-Unsubscribe=One-Click'

const tipsUnsubscribePurpose = 'kody-tips-unsubscribe:v1'

export type TipsUnsubscribeClaims = {
	userId: string
}

type StoredTipsUnsubscribePayload = {
	v: 1
	uid: string
}

export function tipsUnsubscribeHeaders(unsubscribeUrl: string) {
	return {
		'List-Unsubscribe': `<${unsubscribeUrl}>`,
		'List-Unsubscribe-Post': tipsUnsubscribeOneClickBody,
	}
}

export function buildTipsUnsubscribeUrl(input: {
	appBaseUrl: string
	token: string
}) {
	const url = new URL(tipsUnsubscribePath, input.appBaseUrl)
	url.searchParams.set('token', input.token)
	return url.toString()
}

export async function createTipsUnsubscribeToken(input: {
	env: Pick<Env, 'COOKIE_SECRET'>
	userId: string
}) {
	const userId = input.userId.trim()
	if (userId === '') {
		throw new Error('tips unsubscribe token requires a user id')
	}
	const payload = utf8ToBase64Url(
		JSON.stringify({
			v: 1,
			uid: userId,
		} satisfies StoredTipsUnsubscribePayload),
	)
	const signature = await crypto.subtle.sign(
		'HMAC',
		await getTipsUnsubscribeSigningKey(input.env),
		signedTipsUnsubscribeMessage(payload),
	)
	return `${payload}.${bytesToBase64Url(new Uint8Array(signature))}`
}

export async function verifyTipsUnsubscribeToken(input: {
	env: Pick<Env, 'COOKIE_SECRET'>
	token: string | null | undefined
}): Promise<TipsUnsubscribeClaims | null> {
	const token = input.token?.trim() ?? ''
	const [payload, signature, ...rest] = token.split('.')
	if (!payload || !signature || rest.length > 0) return null

	let signatureValid = false
	try {
		signatureValid = await crypto.subtle.verify(
			'HMAC',
			await getTipsUnsubscribeSigningKey(input.env),
			base64UrlToBytes(signature),
			signedTipsUnsubscribeMessage(payload),
		)
	} catch {
		return null
	}
	if (!signatureValid) return null

	let parsed: unknown
	try {
		parsed = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payload)))
	} catch {
		return null
	}
	if (!isStoredTipsUnsubscribePayload(parsed)) return null
	return { userId: parsed.uid }
}

export async function mintTipsUnsubscribeUrl(input: {
	env: Pick<Env, 'COOKIE_SECRET'>
	appBaseUrl: string
	userId: string
}) {
	const token = await createTipsUnsubscribeToken({
		env: input.env,
		userId: input.userId,
	})
	return buildTipsUnsubscribeUrl({
		appBaseUrl: input.appBaseUrl,
		token,
	})
}

export async function isTipsEmailsOptedOut(input: {
	db: D1Database
	userId: string
}) {
	const row = await input.db
		.prepare(
			`SELECT tips_emails_opted_out_at
			 FROM users
			 WHERE stable_user_id = ?`,
		)
		.bind(input.userId)
		.first<{ tips_emails_opted_out_at: string | null }>()
	return row?.tips_emails_opted_out_at != null
}

export async function optOutTipsEmails(input: {
	db: D1Database
	userId: string
	now?: Date
}): Promise<{ optedOut: boolean; alreadyOptedOut: boolean }> {
	const nowIso = (input.now ?? new Date()).toISOString()
	const existing = await input.db
		.prepare(
			`SELECT tips_emails_opted_out_at
			 FROM users
			 WHERE stable_user_id = ? AND deleting_at IS NULL`,
		)
		.bind(input.userId)
		.first<{ tips_emails_opted_out_at: string | null }>()
	if (!existing) return { optedOut: false, alreadyOptedOut: false }
	if (existing.tips_emails_opted_out_at != null) {
		return { optedOut: true, alreadyOptedOut: true }
	}
	const updated = await input.db
		.prepare(
			`UPDATE users
			 SET tips_emails_opted_out_at = COALESCE(tips_emails_opted_out_at, ?),
			     updated_at = ?
			 WHERE stable_user_id = ? AND deleting_at IS NULL`,
		)
		.bind(nowIso, nowIso, input.userId)
		.run()
	return {
		optedOut: (updated.meta.changes ?? 0) > 0,
		alreadyOptedOut: false,
	}
}

function isStoredTipsUnsubscribePayload(
	value: unknown,
): value is StoredTipsUnsubscribePayload {
	if (!value || typeof value !== 'object') return false
	const record = value as Record<string, unknown>
	return (
		record.v === 1 && typeof record.uid === 'string' && record.uid.trim() !== ''
	)
}

async function getTipsUnsubscribeSigningKey(env: Pick<Env, 'COOKIE_SECRET'>) {
	const secret = env.COOKIE_SECRET?.trim()
	if (!secret) {
		throw new Error('Missing COOKIE_SECRET for Kody tips unsubscribe signing.')
	}
	return await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign', 'verify'],
	)
}

function signedTipsUnsubscribeMessage(payload: string) {
	return new TextEncoder().encode(`${tipsUnsubscribePurpose}.${payload}`)
}
