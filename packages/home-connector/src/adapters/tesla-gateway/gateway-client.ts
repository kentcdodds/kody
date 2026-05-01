/**
 * HTTPS client for the Tesla Backup Gateway 2 / Powerwall+ leader local API.
 *
 * The gateway serves a self-signed TLS cert, so requests use a custom https
 * `Agent` with `rejectUnauthorized: false` rather than relying on the system
 * trust store. Authentication is `POST /api/login/Basic` with role `customer`,
 * which returns `Set-Cookie: AuthCookie=...; UserRecord=...`. The cookie jar
 * lasts ~24h and is reused for subsequent reads.
 *
 * Tesla rate-limits `/api/login/Basic` aggressively. After a small burst of
 * failed attempts, the gateway accepts new connections but blackholes login
 * POSTs (no response, eventual timeout). The client therefore tracks the last
 * known rate-limit moment per host and short-circuits new login attempts
 * during the cooldown.
 */
import { request as httpsRequest, Agent as HttpsAgent } from 'node:https'
import {
	type TeslaGatewayApiStatusResponse,
	type TeslaGatewayGeneratorsResponse,
	type TeslaGatewayGridStatusResponse,
	type TeslaGatewayLoginResponse,
	type TeslaGatewayMetersAggregatesResponse,
	type TeslaGatewayNetworksResponse,
	type TeslaGatewayOperationResponse,
	type TeslaGatewayPowerwallsResponse,
	type TeslaGatewaySiteInfoResponse,
	type TeslaGatewaySoeResponse,
	type TeslaGatewaySolarPowerwallResponse,
	type TeslaGatewaySystemStatusResponse,
	type TeslaGatewaySystemUpdateStatusResponse,
} from './types.ts'

const DEFAULT_HTTPS_PORT = 443
const DEFAULT_REQUEST_TIMEOUT_MS = 8_000
const DEFAULT_LOGIN_TIMEOUT_MS = 10_000
const RATE_LIMIT_COOLDOWN_MS = 15 * 60 * 1_000

const sharedInsecureAgent = new HttpsAgent({
	rejectUnauthorized: false,
	keepAlive: true,
	keepAliveMsecs: 60_000,
	maxSockets: 4,
})

const lastRateLimitedAt = new Map<string, number>()

export type TeslaGatewayCredentials = {
	emailLabel: string
	password: string
}

export type TeslaGatewayClientHost = {
	host: string
	port?: number
}

export type TeslaGatewayHttpResponse<T> = {
	status: number
	body: T | null
	rawText: string
	headers: Record<string, string>
}

export class TeslaGatewayHttpError extends Error {
	readonly status: number
	readonly body: unknown
	readonly host: string
	readonly path: string

	constructor(input: {
		status: number
		body: unknown
		host: string
		path: string
		message: string
	}) {
		super(input.message)
		this.name = 'TeslaGatewayHttpError'
		this.status = input.status
		this.body = input.body
		this.host = input.host
		this.path = input.path
	}
}

export class TeslaGatewayRateLimitError extends Error {
	readonly host: string
	readonly retryAfterMs: number

	constructor(host: string, retryAfterMs: number) {
		super(
			`Tesla gateway "${host}" is in login-rate-limit cooldown for another ${Math.ceil(retryAfterMs / 1_000)}s.`,
		)
		this.name = 'TeslaGatewayRateLimitError'
		this.host = host
		this.retryAfterMs = retryAfterMs
	}
}

function rateLimitRemainingMs(host: string) {
	const at = lastRateLimitedAt.get(host)
	if (at === undefined) return 0
	const elapsed = Date.now() - at
	if (elapsed >= RATE_LIMIT_COOLDOWN_MS) {
		lastRateLimitedAt.delete(host)
		return 0
	}
	return RATE_LIMIT_COOLDOWN_MS - elapsed
}

function markRateLimited(host: string) {
	lastRateLimitedAt.set(host, Date.now())
}

/**
 * Reset rate-limit cooldown bookkeeping. Tests use this to make assertions
 * deterministic; production code should not need it.
 */
export function clearTeslaGatewayRateLimits() {
	lastRateLimitedAt.clear()
}

function ensureNotRateLimited(host: string) {
	const remaining = rateLimitRemainingMs(host)
	if (remaining > 0) {
		throw new TeslaGatewayRateLimitError(host, remaining)
	}
}

type LowLevelRequestInput = {
	host: string
	port: number
	method: string
	path: string
	headers?: Record<string, string>
	body?: string
	timeoutMs: number
}

type LowLevelRequestResult = {
	status: number
	headers: Record<string, string>
	setCookieHeaders: Array<string>
	rawText: string
}

function lowercaseHeaderMap(
	headers: Record<string, string | Array<string> | undefined>,
) {
	const map: Record<string, string> = {}
	for (const [key, value] of Object.entries(headers)) {
		if (value === undefined) continue
		if (Array.isArray(value)) {
			map[key.toLowerCase()] = value.join(', ')
		} else {
			map[key.toLowerCase()] = value
		}
	}
	return map
}

function lowLevelRequest(
	input: LowLevelRequestInput,
): Promise<LowLevelRequestResult> {
	return new Promise((resolve, reject) => {
		const req = httpsRequest(
			{
				host: input.host,
				port: input.port,
				method: input.method,
				path: input.path,
				headers: input.headers,
				agent: sharedInsecureAgent,
				timeout: input.timeoutMs,
			},
			(res) => {
				const chunks: Array<Buffer> = []
				res.on('data', (chunk: Buffer) => chunks.push(chunk))
				res.on('end', () => {
					const body = Buffer.concat(chunks).toString('utf8')
					const setCookie = res.headers['set-cookie']
					resolve({
						status: res.statusCode ?? 0,
						headers: lowercaseHeaderMap(res.headers),
						setCookieHeaders: Array.isArray(setCookie) ? setCookie : [],
						rawText: body,
					})
				})
				res.on('error', (err) => reject(err))
			},
		)
		req.on('timeout', () => {
			req.destroy(
				new Error(
					`Tesla gateway request timed out after ${input.timeoutMs}ms (${input.method} ${input.path}).`,
				),
			)
		})
		req.on('error', (err) => reject(err))
		if (input.body !== undefined) req.write(input.body)
		req.end()
	})
}

async function fetchJson<T>(input: {
	host: string
	port: number
	method: string
	path: string
	headers?: Record<string, string>
	body?: string
	timeoutMs?: number
}): Promise<TeslaGatewayHttpResponse<T>> {
	const result = await lowLevelRequest({
		host: input.host,
		port: input.port,
		method: input.method,
		path: input.path,
		headers: input.headers ?? {},
		...(input.body !== undefined ? { body: input.body } : {}),
		timeoutMs: input.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
	})
	let parsed: T | null = null
	if (result.rawText.length > 0) {
		try {
			parsed = JSON.parse(result.rawText) as T
		} catch {
			parsed = null
		}
	}
	return {
		status: result.status,
		body: parsed,
		rawText: result.rawText,
		headers: result.headers,
	}
}

function pickCookieValues(setCookieHeaders: Array<string>) {
	return setCookieHeaders
		.map((header) => header.split(';')[0]?.trim())
		.filter((value): value is string => Boolean(value))
}

/**
 * Authenticate against `POST /api/login/Basic` with role `customer`.
 *
 * The `email` field on this endpoint is a free-form audit label, NOT validated
 * against tesla.com; it gets logged on the gateway and may appear in support
 * traces. We default it to `kody@local` if the caller doesn't pass one.
 */
export async function loginToTeslaGateway(input: {
	host: string
	port?: number
	credentials: TeslaGatewayCredentials
	timeoutMs?: number
}): Promise<TeslaGatewayLoginResponse> {
	ensureNotRateLimited(input.host)
	const port = input.port ?? DEFAULT_HTTPS_PORT
	const body = JSON.stringify({
		username: 'customer',
		email: input.credentials.emailLabel,
		password: input.credentials.password,
		force_sm_off: false,
	})
	let response: TeslaGatewayHttpResponse<{
		token?: string
		email?: string
		loginTime?: string
		expiresAt?: string
	}>
	try {
		response = await fetchJson<{
			token?: string
			email?: string
			loginTime?: string
			expiresAt?: string
		}>({
			host: input.host,
			port,
			method: 'POST',
			path: '/api/login/Basic',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json',
				'User-Agent': 'kody-home-connector/tesla-gateway',
			},
			body,
			timeoutMs: input.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS,
		})
	} catch (error) {
		// A timeout on the login endpoint is the gateway's standard rate-limit
		// signal (it accepts the connection but never responds). Mark cooldown.
		const message = error instanceof Error ? error.message : String(error)
		if (message.includes('timed out')) {
			markRateLimited(input.host)
		}
		throw error
	}
	if (response.status === 429) {
		markRateLimited(input.host)
		throw new TeslaGatewayRateLimitError(input.host, RATE_LIMIT_COOLDOWN_MS)
	}
	if (response.status !== 200) {
		const errorMessage =
			response.body &&
			typeof response.body === 'object' &&
			'error' in response.body
				? String((response.body as { error?: unknown }).error ?? '')
				: response.rawText.slice(0, 200)
		throw new TeslaGatewayHttpError({
			status: response.status,
			body: response.body ?? response.rawText,
			host: input.host,
			path: '/api/login/Basic',
			message: `Tesla gateway login failed (HTTP ${response.status}): ${errorMessage}`,
		})
	}
	const cookies = pickCookieValues(
		response.headers['set-cookie'] ? [response.headers['set-cookie']] : [],
	)
	// `set-cookie` is multi-valued. The lowercase header map has joined them with
	// ", " above, but for cookie purposes we want each individually preserved.
	const rawSetCookie = response.headers['set-cookie']
	const splitCookies = rawSetCookie
		? rawSetCookie
				.split(/,\s*(?=[A-Za-z_][A-Za-z0-9_-]*=)/g)
				.map((header) => header.split(';')[0]?.trim())
				.filter((value): value is string => Boolean(value))
		: cookies
	const cookieHeader = splitCookies.join('; ')
	return {
		cookies: splitCookies,
		cookieHeader,
		token: response.body?.token ?? null,
		email: response.body?.email ?? null,
		loginTimeIso: response.body?.loginTime ?? null,
		expiresAtIso: response.body?.expiresAt ?? null,
	}
}

export type TeslaGatewaySession = {
	host: string
	port: number
	cookieHeader: string
	token: string | null
}

export async function authedGet<T>(input: {
	session: TeslaGatewaySession
	path: string
	timeoutMs?: number
}): Promise<TeslaGatewayHttpResponse<T>> {
	const headers: Record<string, string> = {
		Accept: 'application/json',
		'User-Agent': 'kody-home-connector/tesla-gateway',
	}
	if (input.session.cookieHeader) headers.Cookie = input.session.cookieHeader
	if (input.session.token)
		headers.Authorization = `Bearer ${input.session.token}`
	return await fetchJson<T>({
		host: input.session.host,
		port: input.session.port,
		method: 'GET',
		path: input.path,
		headers,
		...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
	})
}

function unwrap<T>(
	response: TeslaGatewayHttpResponse<T>,
	host: string,
	path: string,
): T {
	if (
		response.status >= 200 &&
		response.status < 300 &&
		response.body !== null
	) {
		return response.body
	}
	throw new TeslaGatewayHttpError({
		status: response.status,
		body: response.body ?? response.rawText,
		host,
		path,
		message: `Tesla gateway GET ${path} failed (HTTP ${response.status}).`,
	})
}

export async function getTeslaApiStatus(session: TeslaGatewaySession) {
	const response = await authedGet<TeslaGatewayApiStatusResponse>({
		session,
		path: '/api/status',
	})
	return unwrap(response, session.host, '/api/status')
}

export async function getTeslaSystemStatus(session: TeslaGatewaySession) {
	const response = await authedGet<TeslaGatewaySystemStatusResponse>({
		session,
		path: '/api/system_status',
	})
	return unwrap(response, session.host, '/api/system_status')
}

export async function getTeslaGridStatus(session: TeslaGatewaySession) {
	const response = await authedGet<TeslaGatewayGridStatusResponse>({
		session,
		path: '/api/system_status/grid_status',
	})
	return unwrap(response, session.host, '/api/system_status/grid_status')
}

export async function getTeslaSoe(session: TeslaGatewaySession) {
	const response = await authedGet<TeslaGatewaySoeResponse>({
		session,
		path: '/api/system_status/soe',
	})
	return unwrap(response, session.host, '/api/system_status/soe')
}

export async function getTeslaMetersAggregates(session: TeslaGatewaySession) {
	const response = await authedGet<TeslaGatewayMetersAggregatesResponse>({
		session,
		path: '/api/meters/aggregates',
	})
	return unwrap(response, session.host, '/api/meters/aggregates')
}

export async function getTeslaOperation(session: TeslaGatewaySession) {
	const response = await authedGet<TeslaGatewayOperationResponse>({
		session,
		path: '/api/operation',
	})
	return unwrap(response, session.host, '/api/operation')
}

export async function getTeslaNetworks(session: TeslaGatewaySession) {
	const response = await authedGet<TeslaGatewayNetworksResponse>({
		session,
		path: '/api/networks',
	})
	return unwrap(response, session.host, '/api/networks')
}

export async function getTeslaSiteInfo(session: TeslaGatewaySession) {
	const response = await authedGet<TeslaGatewaySiteInfoResponse>({
		session,
		path: '/api/site_info',
	})
	return unwrap(response, session.host, '/api/site_info')
}

export async function getTeslaPowerwalls(session: TeslaGatewaySession) {
	const response = await authedGet<TeslaGatewayPowerwallsResponse>({
		session,
		path: '/api/powerwalls',
	})
	return unwrap(response, session.host, '/api/powerwalls')
}

export async function getTeslaSolarPowerwall(session: TeslaGatewaySession) {
	const response = await authedGet<TeslaGatewaySolarPowerwallResponse>({
		session,
		path: '/api/solar_powerwall',
	})
	return unwrap(response, session.host, '/api/solar_powerwall')
}

export async function getTeslaGenerators(session: TeslaGatewaySession) {
	const response = await authedGet<TeslaGatewayGeneratorsResponse>({
		session,
		path: '/api/generators',
	})
	return unwrap(response, session.host, '/api/generators')
}

export async function getTeslaSystemUpdateStatus(session: TeslaGatewaySession) {
	const response = await authedGet<TeslaGatewaySystemUpdateStatusResponse>({
		session,
		path: '/api/system/update/status',
	})
	return unwrap(response, session.host, '/api/system/update/status')
}

/**
 * Convenience: parse the BGW serial out of a DIN like
 * `1232100-00-H--GF22327600010P` -> `GF22327600010P`.
 */
export function extractGatewaySerialFromDin(din: string | null | undefined) {
	if (!din) return null
	const idx = din.indexOf('--')
	if (idx === -1) return null
	const serial = din.slice(idx + 2).trim()
	return serial.length > 0 ? serial : null
}
