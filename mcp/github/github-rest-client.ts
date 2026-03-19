/**
 * Minimal GitHub REST v3 client for work-triage capabilities.
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

export type GitHubPullRequest = {
	number: number
	state: string
	title: string
	html_url: string
	body: string | null
	draft: boolean
	mergeable: boolean | null
	mergeable_state: string | null
	user: { login: string } | null
	head: {
		ref: string
		sha: string
		label: string
	}
	base: { ref: string }
	requested_reviewers?: Array<{ login: string }>
}

export type GitHubCombinedStatus = {
	state: string
	statuses: Array<{
		state: string
		context: string
		description: string | null
	}>
	sha: string
}

export type GitHubReview = {
	id: number
	state: string | null
	user: { login: string } | null
	body: string | null
	submitted_at: string | null
}

export type GitHubSearchIssueItem = {
	id: number
	number: number
	title: string
	html_url: string
	state: string
	assignee: { login: string } | null
	assignees: Array<{ login: string }>
	user: { login: string } | null
	pull_request?: { url: string; html_url?: string } | Record<string, unknown>
	repository_url?: string
	created_at: string
	updated_at: string
}

const defaultUserAgent = 'kody-work-triage/1.0'

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

	async getPullRequest(
		owner: string,
		repo: string,
		pullNumber: number,
	): Promise<GitHubPullRequest> {
		return this.requestJson<GitHubPullRequest>(
			`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}`,
		)
	}

	async listOpenPullsForHead(
		owner: string,
		repo: string,
		headOwner: string,
		headBranch: string,
	): Promise<Array<GitHubPullRequest>> {
		const head = `${headOwner}:${headBranch}`
		const path =
			`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls` +
			`?state=open&head=${encodeURIComponent(head)}`
		return this.requestJson<Array<GitHubPullRequest>>(path)
	}

	async getCombinedStatus(
		owner: string,
		repo: string,
		sha: string,
	): Promise<GitHubCombinedStatus> {
		return this.requestJson<GitHubCombinedStatus>(
			`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(sha)}/status`,
		)
	}

	async listPullReviews(
		owner: string,
		repo: string,
		pullNumber: number,
	): Promise<Array<GitHubReview>> {
		return this.requestJson<Array<GitHubReview>>(
			`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}/reviews`,
		)
	}

	async searchIssues(
		query: string,
		perPage: number,
	): Promise<{
		total_count: number
		items: Array<GitHubSearchIssueItem>
	}> {
		const q = new URLSearchParams({
			q: query,
			per_page: String(Math.min(100, Math.max(1, perPage))),
		})
		return this.requestJson(`/search/issues?${q.toString()}`) as Promise<{
			total_count: number
			items: Array<GitHubSearchIssueItem>
		}>
	}

	/**
	 * EXPERIMENTAL low-level HTTP access for `experimental_github_rest` only.
	 * Behavior, signatures, and error mapping may change without notice; feedback welcome.
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
				input.method === 'PATCH')
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

	private async requestJson<T>(path: string): Promise<T> {
		const url = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`
		const response = await fetch(url, {
			method: 'GET',
			headers: {
				accept: 'application/vnd.github+json',
				'X-GitHub-Api-Version': '2022-11-28',
				authorization: `Bearer ${this.token}`,
				'user-agent': this.userAgent,
			},
		})

		const rateHint = formatRateLimitHint(response)

		if (response.status === 204) {
			return undefined as T
		}

		let body: unknown
		const text = await response.text()
		if (text.trim()) {
			try {
				body = JSON.parse(text)
			} catch {
				throw new GitHubApiError(
					`GitHub returned non-JSON (${response.status}).${rateHint}`,
					{ status: response.status },
				)
			}
		}

		if (!response.ok) {
			const message =
				typeof body === 'object' &&
				body !== null &&
				'message' in body &&
				typeof (body as { message: unknown }).message === 'string'
					? (body as { message: string }).message
					: `GitHub request failed with status ${response.status}`
			const doc =
				typeof body === 'object' &&
				body !== null &&
				'documentation_url' in body &&
				typeof (body as { documentation_url: unknown }).documentation_url ===
					'string'
					? (body as { documentation_url: string }).documentation_url
					: undefined
			throw new GitHubApiError(`${message}.${rateHint}`, {
				status: response.status,
				documentationUrl: doc,
			})
		}

		return body as T
	}
}

function formatRateLimitHint(response: Response) {
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
			'GITHUB_TOKEN is not set. For local dev, run `bun run dev` so the GitHub mock sets a token, or configure a fine-grained PAT.',
		)
	}
	const baseUrl = env.GITHUB_API_BASE_URL?.trim() || 'https://api.github.com'
	return new GitHubRestClient({ token, baseUrl })
}
