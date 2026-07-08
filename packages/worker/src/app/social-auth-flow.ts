import { Session } from 'remix/session'
import { RequestContext } from 'remix/router'
import {
	finishExternalAuth,
	startExternalAuth,
	type OAuthProvider,
} from 'remix/auth'
import { normalizeRedirectTo } from '#app/auth-redirect.ts'
import {
	createOAuthTransactionCookie,
	destroyOAuthTransactionCookie,
	readOAuthTransaction,
	setOAuthTransactionSecret,
	type StoredOAuthTransaction,
} from '#app/oauth-transaction.ts'
import { normalizeInviteCode } from '#app/invites.ts'

const oauthSessionKey = '__auth'

export type StartSocialAuthOptions = {
	returnTo?: string | null
	inviteCode?: string | null
}

export async function startSocialAuth(
	provider: OAuthProvider<unknown, string>,
	request: Request,
	env: Env,
	options: StartSocialAuthOptions = {},
) {
	setOAuthTransactionSecret(env.COOKIE_SECRET)
	const context = new RequestContext(request)
	const session = new Session()
	context.set(Session, session)

	const returnTo = normalizeRedirectTo(options.returnTo ?? null) ?? undefined
	const inviteCode = normalizeInviteCode(options.inviteCode ?? undefined)

	const response = await startExternalAuth(provider, context, {
		returnTo,
		transactionKey: oauthSessionKey,
	})

	const transaction = session.get(oauthSessionKey) as
		| StoredOAuthTransaction
		| undefined
	if (!transaction) {
		throw new Error(`OAuth transaction was not stored for "${provider.name}".`)
	}

	const storedTransaction: StoredOAuthTransaction = {
		...transaction,
		...(inviteCode ? { inviteCode } : {}),
	}
	const transactionCookie = await createOAuthTransactionCookie(
		storedTransaction,
		request,
	)

	const headers = new Headers(response.headers)
	headers.append('Set-Cookie', transactionCookie)
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	})
}

export async function finishSocialAuth(
	provider: OAuthProvider<unknown, string>,
	request: Request,
	env: Env,
) {
	setOAuthTransactionSecret(env.COOKIE_SECRET)
	const storedTransaction = await readOAuthTransaction(request)
	if (!storedTransaction || storedTransaction.provider !== provider.name) {
		throw new Error(`Missing OAuth transaction for "${provider.name}".`)
	}

	const context = new RequestContext(request)
	const session = new Session()
	session.set(oauthSessionKey, storedTransaction)
	context.set(Session, session)

	const { result, returnTo } = await finishExternalAuth(provider, context, {
		transactionKey: oauthSessionKey,
	})

	const destroyTransactionCookie = await destroyOAuthTransactionCookie(request)

	return {
		result,
		returnTo: returnTo ?? storedTransaction.returnTo,
		inviteCode: storedTransaction.inviteCode,
		destroyTransactionCookie,
	}
}
