import { decryptJson, encryptJson } from '#mcp/connections/crypto.ts'
import { type McpUserContext } from '@kody-internal/shared/chat.ts'

const generatedUiSessionPurpose = 'generated-ui-session'
const defaultGeneratedUiSessionTtlMs = 60 * 60 * 1000

type GeneratedUiAppSessionPayload = {
	session_id: string
	user: McpUserContext
	iat: number
	exp: number
}

export type GeneratedUiAppSessionEndpoints = {
	appSource: string
	action: string
	secureInput: string
}

export type GeneratedUiAppSession = {
	sessionId: string
	token: string
	expiresAt: string
	endpoints: GeneratedUiAppSessionEndpoints
}

// Alias to keep the client-facing envelope in sync with session fields.
export type GeneratedUiAppSessionEnvelope = GeneratedUiAppSession

export async function createGeneratedUiAppSession(
	env: Env,
	baseUrl: string,
	user: McpUserContext,
) {
	const now = Date.now()
	const sessionId = crypto.randomUUID()
	const expiresAtMs = now + defaultGeneratedUiSessionTtlMs
	const token = await encryptJson(env, generatedUiSessionPurpose, {
		session_id: sessionId,
		user,
		iat: now,
		exp: expiresAtMs,
	})

	const appBaseUrl = new URL(baseUrl)
	return {
		sessionId,
		token,
		expiresAt: new Date(expiresAtMs).toISOString(),
		endpoints: {
			appSource: new URL('/api/generated-ui/app-source', appBaseUrl).toString(),
			action: new URL('/api/generated-ui/actions', appBaseUrl).toString(),
			secureInput: new URL(
				'/api/generated-ui/secure-input',
				appBaseUrl,
			).toString(),
		},
	} satisfies GeneratedUiAppSession
}

export async function verifyGeneratedUiAppSession(env: Env, token: string) {
	const payload = await decryptJson<GeneratedUiAppSessionPayload>(
		env,
		generatedUiSessionPurpose,
		token,
	)
	if (!payload?.user || typeof payload.user.userId !== 'string') {
		throw new Error('Invalid generated UI session payload.')
	}
	if (typeof payload.exp === 'number' && Date.now() > payload.exp) {
		throw new Error('Generated UI session has expired.')
	}
	return payload
}
