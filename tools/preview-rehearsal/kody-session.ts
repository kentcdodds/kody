import {
	defaultMcpCallOptions,
	readExecuteResult,
	readMcpToolPayload,
} from '../control-kody/mcp-tool-result.ts'
import { connectAppMcpClient, loginToApp } from '../mcp-oauth-client.ts'

export type RehearsalCredentials = {
	email: string
	username: string
	password: string
}

export type RehearsalSession = {
	email: string
	cookieHeader: string
	execute: (code: string, params?: Record<string, unknown>) => Promise<unknown>
	api: (
		operationId: string,
		params?: Record<string, unknown>,
	) => Promise<unknown>
	/** Same-origin JSON request as the signed-in browser session. */
	request: (
		path: string,
		init?: { method?: string; body?: unknown },
	) => Promise<{ status: number; body: unknown; location: string | null }>
	close: () => Promise<void>
}

export async function postJson(
	url: string,
	body: unknown,
	headers: Record<string, string> = {},
) {
	const response = await fetch(url, {
		method: 'POST',
		headers: {
			Accept: 'application/json',
			'Content-Type': 'application/json',
			...headers,
		},
		body: JSON.stringify(body),
		redirect: 'manual',
	})
	const text = await response.text()
	let parsed: unknown = text
	try {
		parsed = JSON.parse(text)
	} catch {
		// Non-JSON bodies (HTML error pages) stay as text for the error message.
	}
	return { status: response.status, body: parsed }
}

export function describeFailure(
	path: string,
	result: { status: number; body: unknown },
) {
	const detail =
		typeof result.body === 'string'
			? result.body.slice(0, 400)
			: JSON.stringify(result.body)
	return `${path} returned HTTP ${result.status}: ${detail}`
}

/**
 * Sign in through `/auth` (session cookie) and the MCP OAuth flow (one new
 * MCP OAuth connection per call), the same way an agent connects. `orgSlug`
 * binds the MCP connection to that org instead of the personal org.
 */
export async function openRehearsalSession(
	origin: string,
	credentials: RehearsalCredentials,
	options: { orgSlug?: string } = {},
): Promise<RehearsalSession> {
	const cookieHeader = await loginToApp(origin, credentials)
	const connection = await connectAppMcpClient(origin, credentials, {
		cookieHeader,
		clientName: 'kody-preview-rehearsal',
		orgSlug: options.orgSlug,
	})
	const callTool = async (name: string, args: Record<string, unknown>) =>
		connection.client.callTool({ name, arguments: args }, defaultMcpCallOptions)
	return {
		email: credentials.email,
		cookieHeader: connection.cookieHeader,
		async execute(code, params) {
			return readExecuteResult(
				await callTool('execute', { code, ...(params ? { params } : {}) }),
			)
		},
		async api(operationId, params) {
			const payload = readMcpToolPayload(
				await callTool('api', { operationId, params: params ?? {} }),
			) as { result?: unknown; error?: { message?: string } }
			if (payload && typeof payload === 'object' && payload.error) {
				throw new Error(
					`api ${operationId} failed: ${payload.error.message ?? JSON.stringify(payload.error)}`,
				)
			}
			return payload?.result ?? null
		},
		async request(path, init = {}) {
			const response = await fetch(new URL(path, origin), {
				method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
				headers: {
					Accept: 'application/json',
					Cookie: connection.cookieHeader,
					Origin: origin,
					...(init.body === undefined
						? {}
						: { 'Content-Type': 'application/json' }),
				},
				...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
				redirect: 'manual',
			})
			const text = await response.text()
			let body: unknown = text
			try {
				body = JSON.parse(text)
			} catch {
				// Keep the text body for error messages.
			}
			return {
				status: response.status,
				body,
				location: response.headers.get('Location'),
			}
		},
		async close() {
			await connection[Symbol.asyncDispose]()
		},
	}
}

/** Fail loudly unless a session JSON request returned 2xx with `ok !== false`. */
export async function requestOk(
	session: RehearsalSession,
	path: string,
	init?: { method?: string; body?: unknown },
) {
	const result = await session.request(path, init)
	const okFlag =
		result.body && typeof result.body === 'object'
			? (result.body as { ok?: unknown }).ok
			: undefined
	if (result.status < 200 || result.status >= 300 || okFlag === false) {
		throw new Error(describeFailure(path, result))
	}
	return result.body
}
