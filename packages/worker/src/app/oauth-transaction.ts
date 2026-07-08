import { createCookie } from '@remix-run/cookie'
import { isSecureRequest } from '#app/auth-session.ts'

export type OAuthTransaction = {
	provider: string
	state: string
	codeVerifier: string
	returnTo?: string
	providerState?: string
}

const transactionMaxAgeSeconds = 60 * 10

export type StoredOAuthTransaction = OAuthTransaction & {
	inviteCode?: string
}

let transactionCookie: ReturnType<typeof createCookie> | null = null
let transactionSecret: string | null = null

export function setOAuthTransactionSecret(secret: string) {
	if (!secret) {
		throw new Error('Missing COOKIE_SECRET for OAuth transaction signing.')
	}

	if (transactionCookie && transactionSecret === secret) {
		return
	}

	transactionSecret = secret
	transactionCookie = createCookie('kody_oauth_transaction', {
		httpOnly: true,
		sameSite: 'Lax',
		path: '/',
		maxAge: transactionMaxAgeSeconds,
		secrets: [secret],
	})
}

function getTransactionCookie() {
	if (!transactionCookie) {
		throw new Error(
			'OAuth transaction cookie not configured. Call setOAuthTransactionSecret.',
		)
	}

	return transactionCookie
}

function isStoredOAuthTransaction(
	value: unknown,
): value is StoredOAuthTransaction {
	if (!value || typeof value !== 'object') return false
	const record = value as Record<string, unknown>
	return (
		typeof record.provider === 'string' &&
		record.provider.length > 0 &&
		typeof record.state === 'string' &&
		record.state.length > 0 &&
		typeof record.codeVerifier === 'string' &&
		record.codeVerifier.length > 0 &&
		(record.returnTo === undefined || typeof record.returnTo === 'string') &&
		(record.inviteCode === undefined || typeof record.inviteCode === 'string')
	)
}

export async function createOAuthTransactionCookie(
	transaction: StoredOAuthTransaction,
	request: Request,
) {
	const secure = isSecureRequest(request)
	return getTransactionCookie().serialize(JSON.stringify(transaction), {
		secure,
	})
}

export async function destroyOAuthTransactionCookie(request: Request) {
	const secure = isSecureRequest(request)
	return getTransactionCookie().serialize('', {
		secure,
		maxAge: 0,
		expires: new Date(0),
	})
}

export async function readOAuthTransaction(
	request: Request,
): Promise<StoredOAuthTransaction | null> {
	const cookieHeader = request.headers.get('Cookie')
	if (!cookieHeader) return null

	const raw = await getTransactionCookie().parse(cookieHeader)
	if (raw == null) return null

	let parsed: unknown = raw
	if (typeof raw === 'string') {
		try {
			parsed = JSON.parse(raw)
		} catch {
			return null
		}
	}

	return isStoredOAuthTransaction(parsed) ? parsed : null
}
