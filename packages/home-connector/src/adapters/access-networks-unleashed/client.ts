import { type HomeConnectorConfig } from '../../config.ts'
import { fetchAccessNetworksUnleashed } from './http.ts'
import { parseAccessNetworksUnleashedXml } from './xml.ts'
import {
	type AccessNetworksUnleashedAjaxAction,
	type AccessNetworksUnleashedClient,
	type AccessNetworksUnleashedPersistedController,
	type AccessNetworksUnleashedRequestInput,
	type AccessNetworksUnleashedRequestResult,
} from './types.ts'

type SessionState = {
	baseUrl: string | null
	loginUrl: string | null
	csrfToken: string | null
	cookie: string | null
}

function escapeXmlAttribute(value: string) {
	return value
		.replace(/&/g, '&amp;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
}

function normalizeHost(host: string) {
	const trimmed = host.trim()
	if (/^https?:\/\//i.test(trimmed)) return trimmed.replace(/\/+$/, '')
	return `https://${trimmed.replace(/\/+$/, '')}`
}

function generateUpdater(comp: string) {
	const safeComp = comp.replace(/[^a-zA-Z0-9_-]/g, '') || 'comp'
	const ts = Date.now()
	const rand = Math.random().toString(36).slice(2, 10)
	return `${safeComp}.${ts}.${rand}`
}

function collectCookies(headers: Headers, existing: string | null) {
	const cookies = new Map<string, string>()
	if (existing) {
		for (const cookie of existing.split(';')) {
			const [name, ...rest] = cookie.trim().split('=')
			if (name && rest.length > 0) cookies.set(name, rest.join('='))
		}
	}
	const setCookie =
		typeof headers.getSetCookie === 'function'
			? headers.getSetCookie()
			: headers.get('set-cookie')
				? [headers.get('set-cookie') ?? '']
				: []
	for (const cookieHeader of setCookie) {
		const [cookie] = cookieHeader.split(';')
		const [name, ...rest] = cookie.trim().split('=')
		if (name && rest.length > 0) cookies.set(name, rest.join('='))
	}
	return [...cookies.entries()]
		.map(([name, value]) => `${name}=${value}`)
		.join('; ')
}

function extractCsrfToken(text: string) {
	const match =
		/HTTP_X_CSRF_TOKEN["']?\s*[:=]\s*["']([^"']+)["']/i.exec(text) ??
		/X-CSRF-Token["']?\s*[:=]\s*["']([^"']+)["']/i.exec(text) ??
		/([a-zA-Z0-9]{10,})/.exec(text)
	return match?.[1] ?? null
}

export function createAccessNetworksUnleashedAjaxClient(input: {
	config: HomeConnectorConfig
	controller: AccessNetworksUnleashedPersistedController
}): AccessNetworksUnleashedClient {
	const { config } = input
	const state: SessionState = {
		baseUrl: null,
		loginUrl: null,
		csrfToken: null,
		cookie: null,
	}
	let loginPromise: Promise<void> | null = null

	function requireConfig() {
		const host = input.controller.host.trim()
		const username = input.controller.username
		const password = input.controller.password
		if (
			!host ||
			username == null ||
			password == null ||
			username.length === 0 ||
			password.length === 0
		) {
			throw new Error(
				'Access Networks Unleashed requires an adopted controller with stored credentials. Run access_networks_unleashed_scan_controllers, access_networks_unleashed_adopt_controller, then access_networks_unleashed_set_credentials.',
			)
		}
		return {
			host: normalizeHost(host),
			username,
			password,
		}
	}

	async function rawRequest(
		url: string,
		init: RequestInit,
		allowInsecureTls: boolean,
		timeoutMs = config.accessNetworksUnleashedRequestTimeoutMs,
	) {
		const headers = new Headers(init.headers)
		if (state.cookie) headers.set('Cookie', state.cookie)
		if (state.csrfToken) headers.set('X-CSRF-Token', state.csrfToken)
		const response = await fetchAccessNetworksUnleashed({
			url,
			timeoutMs,
			allowInsecureTls,
			init: {
				...init,
				headers,
				redirect: 'manual',
			} as RequestInit,
		})
		state.cookie = collectCookies(response.headers, state.cookie)
		return response
	}

	// Login uses the controller-wide TLS setting. The per-request override on
	// `client.request(...)` only applies to the actual _cmdstat.jsp post; the
	// session-establishment hops are concurrency-shared (see ensureSession),
	// so the first caller's per-request override would otherwise silently win
	// for every concurrent caller.
	async function login() {
		const allowInsecureTls = config.accessNetworksUnleashedAllowInsecureTls
		const credentials = requireConfig()
		let csrfToken: string | null = null
		const head = await rawRequest(
			credentials.host,
			{ method: 'GET' },
			allowInsecureTls,
			3_000,
		)
		const location = head.headers.get('location')
		if (!location) {
			throw new Error(
				'Access Networks Unleashed login did not return an admin redirect.',
			)
		}
		const loginUrl = new URL(location, head.url || credentials.host).toString()
		const baseUrl = new URL('.', loginUrl).toString().replace(/\/$/, '')
		const loginPage = await rawRequest(
			loginUrl,
			{
				method: 'GET',
				headers: { Accept: '*/*' },
			},
			allowInsecureTls,
		)
		const loginWithParams = new URL(loginPage.url || loginUrl)
		loginWithParams.searchParams.set('username', credentials.username)
		loginWithParams.searchParams.set('password', credentials.password)
		loginWithParams.searchParams.set('ok', 'Log In')
		const loginResult = await rawRequest(
			loginWithParams.toString(),
			{ method: 'GET' },
			allowInsecureTls,
		)
		if (loginResult.status === 200) {
			throw new Error('Access Networks Unleashed login was rejected.')
		}
		const csrfHeader =
			loginResult.headers.get('HTTP_X_CSRF_TOKEN') ??
			loginResult.headers.get('x-csrf-token')
		if (csrfHeader) {
			csrfToken = csrfHeader
		} else {
			const tokenResponse = await rawRequest(
				`${baseUrl}/_csrfTokenVar.jsp`,
				{ method: 'GET' },
				allowInsecureTls,
			)
			if (tokenResponse.ok) {
				csrfToken = extractCsrfToken(await tokenResponse.text())
			}
		}
		state.loginUrl = loginUrl
		state.baseUrl = baseUrl
		state.csrfToken = csrfToken
	}

	async function ensureSession() {
		if (state.baseUrl) return
		loginPromise ??= login().finally(() => {
			loginPromise = null
		})
		await loginPromise
	}

	function resetSession() {
		state.baseUrl = null
		state.loginUrl = null
		state.csrfToken = null
		state.cookie = null
	}

	function isMutatingAction(action: AccessNetworksUnleashedAjaxAction) {
		return action !== 'getstat'
	}

	async function postCmdstat(
		xml: string,
		action: AccessNetworksUnleashedAjaxAction,
		allowInsecureTls: boolean,
		redirectCount = 0,
	): Promise<string> {
		await ensureSession()
		if (!state.baseUrl) {
			throw new Error('Access Networks Unleashed session has no base URL.')
		}
		// Unleashed (and ZoneDirector) expect the AJAX envelope as the raw XML
		// request body with `Content-Type: text/xml`. They silently return an
		// empty body for url-encoded `request=...` form submissions.
		const response = await rawRequest(
			`${state.baseUrl}/_cmdstat.jsp`,
			{
				method: 'POST',
				headers: {
					'Content-Type': 'text/xml',
					Accept: 'text/xml, */*',
				},
				body: xml,
			},
			allowInsecureTls,
		)
		if (response.status === 302) {
			resetSession()
			if (isMutatingAction(action)) {
				throw new Error(
					'Access Networks Unleashed redirected during a command. The session was reset; retry after confirming the command did not already apply.',
				)
			}
			if (redirectCount >= 1) {
				throw new Error(
					'Access Networks Unleashed redirected after reauthentication.',
				)
			}
			await ensureSession()
			return await postCmdstat(xml, action, allowInsecureTls, redirectCount + 1)
		}
		const text = await response.text()
		if (!response.ok) {
			throw new Error(
				`Access Networks Unleashed request failed with HTTP ${response.status}: ${text.trim()}`,
			)
		}
		if (!text.trim()) {
			throw new Error('Access Networks Unleashed returned an empty response.')
		}
		if (
			/<xmsg\b[^>]*\b(?:error|status)=["'](?:1|true|error|failed)["']/i.test(
				text,
			)
		) {
			throw new Error(`Access Networks Unleashed rejected the command: ${text}`)
		}
		return text
	}

	return {
		async request(
			requestInput: AccessNetworksUnleashedRequestInput,
		): Promise<AccessNetworksUnleashedRequestResult> {
			const action = requestInput.action
			const comp = requestInput.comp.trim()
			if (!comp) {
				throw new Error('comp must be a non-empty Unleashed component name.')
			}
			const xmlBody = requestInput.xmlBody
			if (typeof xmlBody !== 'string') {
				throw new Error('xmlBody must be a string of inner ajax-request XML.')
			}
			const updater = requestInput.updater?.trim() || generateUpdater(comp)
			const allowInsecureTls =
				requestInput.allowInsecureTls ??
				config.accessNetworksUnleashedAllowInsecureTls
			const envelope =
				`<ajax-request action='${escapeXmlAttribute(action)}' ` +
				`comp='${escapeXmlAttribute(comp)}' ` +
				`updater='${escapeXmlAttribute(updater)}'>` +
				`${xmlBody}</ajax-request>`
			const xml = await postCmdstat(envelope, action, allowInsecureTls)
			return {
				action,
				comp,
				updater,
				xml,
				parsed: parseAccessNetworksUnleashedXml(xml),
			}
		},
	}
}
