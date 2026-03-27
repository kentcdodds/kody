import { type McpUserContext } from '@kody-internal/shared/chat.ts'
import {
	decryptStringWithPurpose,
	encryptStringWithPurpose,
} from '#mcp/secrets/crypto.ts'

const generatedUiSessionPurpose = 'generated-ui-session'
const defaultGeneratedUiSessionTtlMs = 60 * 60 * 1000

type GeneratedUiAppSessionPayload = {
	session_id: string
	app_id: string | null
	params: Record<string, unknown>
	home_connector_id: string | null
	user: McpUserContext
	iat: number
	exp: number
}

export type GeneratedUiAppSessionEndpoints = {
	source: string
	execute: string
	secrets: string
	deleteSecret: string
}

export type GeneratedUiAppSession = {
	sessionId: string
	token: string
	expiresAt: string
	endpoints: GeneratedUiAppSessionEndpoints
}

export async function createGeneratedUiAppSession(input: {
	env: Pick<Env, 'COOKIE_SECRET'>
	baseUrl: string
	user: McpUserContext
	appId?: string | null
	params?: Record<string, unknown>
	homeConnectorId?: string | null
}) {
	const now = Date.now()
	const sessionId = crypto.randomUUID()
	const expiresAtMs = now + defaultGeneratedUiSessionTtlMs
	const token = await encryptStringWithPurpose(
		input.env,
		generatedUiSessionPurpose,
		JSON.stringify({
			session_id: sessionId,
			app_id: input.appId ?? null,
			params: input.params ?? {},
			home_connector_id: input.homeConnectorId ?? null,
			user: input.user,
			iat: now,
			exp: expiresAtMs,
		} satisfies GeneratedUiAppSessionPayload),
	)
	const appBaseUrl = new URL(input.baseUrl)
	return {
		sessionId,
		token,
		expiresAt: new Date(expiresAtMs).toISOString(),
		endpoints: {
			source: new URL(`/ui-api/${sessionId}/source`, appBaseUrl).toString(),
			execute: new URL(`/ui-api/${sessionId}/execute`, appBaseUrl).toString(),
			secrets: new URL(`/ui-api/${sessionId}/secrets`, appBaseUrl).toString(),
			deleteSecret: new URL(
				`/ui-api/${sessionId}/secrets/delete`,
				appBaseUrl,
			).toString(),
		},
	} satisfies GeneratedUiAppSession
}

export async function verifyGeneratedUiAppSession(
	env: Pick<Env, 'COOKIE_SECRET'>,
	token: string,
) {
	const raw = await decryptStringWithPurpose(
		env,
		generatedUiSessionPurpose,
		token,
	)
	const payload = JSON.parse(raw) as Partial<GeneratedUiAppSessionPayload>
	if (
		typeof payload.session_id !== 'string' ||
		!payload.user ||
		typeof payload.user.userId !== 'string'
	) {
		throw new Error('Invalid generated UI session payload.')
	}
	if (typeof payload.exp === 'number' && Date.now() > payload.exp) {
		throw new Error('Generated UI session has expired.')
	}
	return payload as GeneratedUiAppSessionPayload
}
