/**
 * Minimal Cursor Cloud Agents API client for the `cursor_cloud_rest` capability.
 * @see https://cursor.com/docs/cloud-agent/api/endpoints
 */

export type CursorCloudClientOptions = {
	apiKey: string
	baseUrl?: string
	userAgent?: string
}

export class CursorCloudApiError extends Error {
	readonly status: number
	constructor(message: string, options: { status: number; cause?: unknown }) {
		super(message, { cause: options.cause })
		this.name = 'CursorCloudApiError'
		this.status = options.status
	}
}

const defaultUserAgent = 'kody-cursor-cloud-rest/1.0'
const defaultBaseUrl = 'https://api.cursor.com'

function basicAuthHeader(apiKey: string) {
	const token = apiKey.trim()
	const credentials = btoa(`${token}:`)
	return `Basic ${credentials}`
}

export class CursorCloudClient {
	private readonly apiKey: string
	private readonly baseUrl: string
	private readonly userAgent: string

	constructor(options: CursorCloudClientOptions) {
		this.apiKey = options.apiKey.trim()
		this.baseUrl = (options.baseUrl ?? defaultBaseUrl).replace(/\/$/, '')
		this.userAgent = options.userAgent?.trim() || defaultUserAgent
	}

	async rawRequest(input: {
		method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
		path: string
		query?: Record<string, string>
		body?: unknown
	}): Promise<{ status: number; body: unknown | null }> {
		const pathPart = input.path.startsWith('/') ? input.path : `/${input.path}`
		const url = new URL(`${this.baseUrl}${pathPart}`)
		if (input.query) {
			for (const [key, value] of Object.entries(input.query)) {
				url.searchParams.set(key, value)
			}
		}

		const headers: Record<string, string> = {
			accept: 'application/json',
			authorization: basicAuthHeader(this.apiKey),
			'user-agent': this.userAgent,
		}

		const init: RequestInit = {
			method: input.method,
			headers,
		}

		if (
			input.body !== undefined &&
			(input.method === 'POST' ||
				input.method === 'PUT' ||
				input.method === 'PATCH' ||
				input.method === 'DELETE')
		) {
			headers['content-type'] = 'application/json'
			init.body = JSON.stringify(input.body)
		}

		const response = await fetch(url.toString(), init)
		const text = await response.text()

		if (response.status === 204 || !text.trim()) {
			return { status: response.status, body: null }
		}

		try {
			return { status: response.status, body: JSON.parse(text) as unknown }
		} catch {
			throw new CursorCloudApiError(
				`Cursor Cloud API returned non-JSON (${response.status}).`,
				{ status: response.status },
			)
		}
	}
}

export function createCursorCloudClient(
	env: Pick<Env, 'CURSOR_API_KEY' | 'CURSOR_API_BASE_URL'>,
): CursorCloudClient {
	const apiKey = env.CURSOR_API_KEY?.trim()
	if (!apiKey) {
		throw new Error(
			'CURSOR_API_KEY is not set. For local dev, run `npm run dev` so the Cursor mock sets a key, or set a Cursor API key from https://cursor.com/settings.',
		)
	}
	const baseUrl = env.CURSOR_API_BASE_URL?.trim() || defaultBaseUrl
	return new CursorCloudClient({ apiKey, baseUrl })
}
