/**
 * Minimal GitHub GraphQL client for GitHub capabilities.
 */

import { formatRateLimitHint, GitHubApiError } from '#mcp/github/github-rest-client.ts'

export type GitHubGraphqlClientOptions = {
	token: string
	baseUrl?: string
	userAgent?: string
}

export type GitHubGraphqlRequest = {
	query: string
	variables?: Record<string, unknown>
	operationName?: string
}

export type GitHubGraphqlResponse = {
	data?: unknown
	errors?: Array<unknown>
	extensions?: unknown
}

const defaultUserAgent = 'kody-github-graphql/1.0'

export class GitHubGraphqlClient {
	private readonly token: string
	private readonly endpoint: string
	private readonly userAgent: string

	constructor(options: GitHubGraphqlClientOptions) {
		this.token = options.token.trim()
		this.endpoint = resolveGraphqlEndpoint(options.baseUrl)
		this.userAgent = options.userAgent?.trim() || defaultUserAgent
	}

	/**
	 * Low-level HTTP access for the `github_graphql` capability.
	 * All requests are POSTed to the configured GraphQL endpoint.
	 */
	async query(
		input: GitHubGraphqlRequest,
	): Promise<{ status: number; body: GitHubGraphqlResponse | null }> {
		const headers: Record<string, string> = {
			accept: 'application/vnd.github+json',
			'X-GitHub-Api-Version': '2022-11-28',
			authorization: `Bearer ${this.token}`,
			'user-agent': this.userAgent,
			'content-type': 'application/json',
		}

		const init: RequestInit = {
			method: 'POST',
			headers,
			body: JSON.stringify({
				query: input.query,
				variables: input.variables,
				operationName: input.operationName,
			}),
		}

		const response = await fetch(this.endpoint, init)
		const text = await response.text()

		if (response.status === 204 || !text.trim()) {
			return { status: response.status, body: null }
		}

		try {
			return {
				status: response.status,
				body: JSON.parse(text) as GitHubGraphqlResponse,
			}
		} catch {
			throw new GitHubApiError(
				`GitHub returned non-JSON (${response.status}).${formatRateLimitHint(response)}`,
				{ status: response.status },
			)
		}
	}
}

export function createGitHubGraphqlClient(
	env: Pick<Env, 'GITHUB_TOKEN' | 'GITHUB_API_BASE_URL'>,
): GitHubGraphqlClient {
	const token = env.GITHUB_TOKEN?.trim()
	if (!token) {
		throw new Error(
			'GITHUB_TOKEN is not set. For local dev, run `bun run dev` so the GitHub mock sets a token, or configure a fine-grained PAT for the kody-bot account.',
		)
	}
	return new GitHubGraphqlClient({
		token,
		baseUrl: env.GITHUB_API_BASE_URL?.trim() || 'https://api.github.com',
	})
}

function resolveGraphqlEndpoint(baseUrl: string | undefined) {
	const root = (baseUrl ?? 'https://api.github.com').trim().replace(/\/$/, '')
	if (root.endsWith('/graphql')) return root
	return `${root}/graphql`
}

