/**
 * Minimal GitHub REST v3 client for GitHub capabilities.
 */

export type GitHubRestClientOptions = {
	token: string
	baseUrl?: string
	userAgent?: string
}

export class GitHubApiError extends Error {
	readonly status: number
	readonly documentationUrl?: string
	constructor(
		message: string,
		options: { status: number; documentationUrl?: string; cause?: unknown },
	) {
		super(message, { cause: options.cause })
		this.name = 'GitHubApiError'
		this.status = options.status
		this.documentationUrl = options.documentationUrl
	}
}

const defaultUserAgent = 'kody-github-rest/1.0'

export class GitHubRestClient {
	private readonly token: string
	private readonly baseUrl: string
	private readonly userAgent: string

	constructor(options: GitHubRestClientOptions) {
		this.token = options.token.trim()
		this.baseUrl = (options.baseUrl ?? 'https://api.github.com').replace(
			/\/$/,
			'',
		)
		this.userAgent = options.userAgent?.trim() || defaultUserAgent
	}

	/**
	 * Low-level HTTP access for the `github_rest` capability.
	 * All requests use the configured `baseUrl` (live GitHub or mock); `path` must be relative.
	 */
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
			accept: 'application/vnd.github+json',
			'X-GitHub-Api-Version': '2022-11-28',
			authorization: `Bearer ${this.token}`,
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
			throw new GitHubApiError(
				`GitHub returned non-JSON (${response.status}).${formatRateLimitHint(response)}`,
				{ status: response.status },
			)
		}
	}
}

export function formatRateLimitHint(response: Response) {
	const remaining = response.headers.get('x-ratelimit-remaining')
	if (remaining === null) return ''
	const reset = response.headers.get('x-ratelimit-reset')
	const resetHint =
		reset && /^\d+$/.test(reset)
			? ` Resets around ${new Date(Number.parseInt(reset, 10) * 1000).toISOString()}.`
			: ''
	return ` (rate limit remaining: ${remaining}${resetHint})`
}

export function createGitHubRestClient(
	env: Pick<Env, 'GITHUB_TOKEN' | 'GITHUB_API_BASE_URL'>,
): GitHubRestClient {
	const token = env.GITHUB_TOKEN?.trim()
	if (!token) {
		throw new Error(
			'GITHUB_TOKEN is not set. For local dev, run `npm run dev` so the GitHub mock sets a token, or configure a fine-grained PAT for the kody-bot account.',
		)
	}
	const baseUrl = env.GITHUB_API_BASE_URL?.trim() || 'https://api.github.com'
	return new GitHubRestClient({ token, baseUrl })
}
