/**
 * Minimal GitHub REST API v3 mock for local dev and tests.
 * Mirrors only the routes used by work-triage capabilities.
 */

type MockGithubEnv = {
	MOCK_API_TOKEN?: string
}

type DashboardEndpoint = {
	method: string
	path: string
	description: string
	requiresAuth: boolean
}

const dashboardEndpoints: Array<DashboardEndpoint> = [
	{
		method: 'GET',
		path: '/repos/{owner}/{repo}/pulls/{pull_number}',
		description: 'Get a pull request',
		requiresAuth: true,
	},
	{
		method: 'GET',
		path: '/repos/{owner}/{repo}/pulls',
		description: 'List pull requests (supports head=owner:branch, state=open)',
		requiresAuth: true,
	},
	{
		method: 'GET',
		path: '/repos/{owner}/{repo}/commits/{ref}/status',
		description: 'Combined commit status',
		requiresAuth: true,
	},
	{
		method: 'GET',
		path: '/repos/{owner}/{repo}/pulls/{pull_number}/reviews',
		description: 'List PR reviews',
		requiresAuth: true,
	},
	{
		method: 'GET',
		path: '/search/issues',
		description: 'Search issues (subset of query params for mock fixtures)',
		requiresAuth: true,
	},
	{
		method: 'GET',
		path: '/__mocks',
		description: 'Mock dashboard (HTML)',
		requiresAuth: false,
	},
	{
		method: 'GET',
		path: '/__mocks/meta',
		description: 'Mock metadata (JSON)',
		requiresAuth: false,
	},
]

/** Fixture PR #42 — mergeable with one failing check and mixed reviews */
const fixturePullHeadSha = 'abc123def456abc123def456abc123def456abcd'
const fixturePull = {
	number: 42,
	state: 'open',
	title: 'Mock PR: tighten work triage smoke test',
	body: '## Summary\nDeterministic mock PR for local `work-triage` capabilities.',
	user: {
		login: 'octokitten',
		id: 1,
		avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4',
	},
	html_url: 'https://github.com/kentcdodds/kody/pull/42',
	diff_url: 'https://github.com/kentcdodds/kody/pull/42.diff',
	patch_url: 'https://github.com/kentcdodds/kody/pull/42.patch',
	assignees: [],
	requested_reviewers: [{ login: 'kentcdodds', id: 2 }],
	draft: false,
	mergeable: true,
	mergeable_state: 'blocked',
	merged: false,
	merged_at: null,
	head: {
		label: 'kentcdodds:fix/ci',
		ref: 'fix/ci',
		sha: fixturePullHeadSha,
		user: { login: 'kentcdodds', id: 3 },
		repo: {
			name: 'kody',
			full_name: 'kentcdodds/kody',
			private: false,
		},
	},
	base: {
		label: 'kentcdodds:main',
		ref: 'main',
		sha: 'base000sha000base000sha000base000sha000b',
		user: { login: 'kentcdodds', id: 3 },
		repo: {
			name: 'kody',
			full_name: 'kentcdodds/kody',
			private: false,
		},
	},
}

const fixtureCombinedStatus = {
	state: 'failure',
	statuses: [
		{
			state: 'success',
			description: 'lint passed',
			context: 'lint',
			target_url: 'https://github.com/kentcdodds/kody/actions',
		},
		{
			state: 'failure',
			description: 'typecheck failed',
			context: 'types',
			target_url: 'https://github.com/kentcdodds/kody/actions',
		},
	],
	sha: fixturePullHeadSha,
	total_count: 2,
}

const fixtureReviews = [
	{
		id: 101,
		user: { login: 'reviewer-one', id: 10 },
		body: 'LGTM with nits',
		state: 'APPROVED',
		submitted_at: '2026-01-15T18:00:00Z',
	},
	{
		id: 102,
		user: { login: 'reviewer-two', id: 11 },
		body: 'Please fix types',
		state: 'CHANGES_REQUESTED',
		submitted_at: '2026-01-16T09:30:00Z',
	},
]

const fixtureSecondPull = {
	number: 7,
	state: 'open',
	title: 'Mock PR: docs housekeeping',
	user: { login: 'doc-bot', id: 20 },
	html_url: 'https://github.com/kentcdodds/kody/pull/7',
	head: {
		label: 'kentcdodds:chore/docs',
		ref: 'chore/docs',
		sha: 'def456def456def456def456def456def456def4',
		user: { login: 'kentcdodds', id: 3 },
		repo: { name: 'kody', full_name: 'kentcdodds/kody', private: false },
	},
	base: fixturePull.base,
	draft: false,
	mergeable: true,
	mergeable_state: 'clean',
	merged: false,
}

const fixtureSearchAssigneeIssue = {
	id: 9001,
	number: 11,
	state: 'open',
	title: 'Mock issue assigned to you',
	html_url: 'https://github.com/kentcdodds/kody/issues/11',
	repository_url: 'https://api.github.com/repos/kentcdodds/kody',
	labels: [{ name: 'bug', color: 'd73a4a' }],
	assignee: { login: 'kentcdodds', id: 100 },
	assignees: [{ login: 'kentcdodds', id: 100 }],
	user: { login: 'octokitten', id: 1 },
	created_at: '2026-01-10T12:00:00Z',
	updated_at: '2026-01-18T08:00:00Z',
}

const fixtureSearchReviewRequestedPr = {
	id: 9002,
	number: 99,
	state: 'open',
	title: 'Mock PR awaiting your review',
	html_url: 'https://github.com/epic-web-dev/epic-stack/pull/99',
	repository_url: 'https://api.github.com/repos/epic-web-dev/epic-stack',
	pull_request: {
		url: 'https://api.github.com/repos/epic-web-dev/epic-stack/pulls/99',
		html_url: 'https://github.com/epic-web-dev/epic-stack/pull/99',
	},
	labels: [],
	user: { login: 'contributor', id: 50 },
	created_at: '2026-01-17T10:00:00Z',
	updated_at: '2026-01-17T16:00:00Z',
}

function json(data: unknown, init: ResponseInit = {}) {
	const headers = new Headers(init.headers)
	if (!headers.has('content-type')) {
		headers.set('content-type', 'application/json; charset=utf-8')
	}
	return new Response(JSON.stringify(data, null, 2), { ...init, headers })
}

function htmlEscape(value: string) {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;')
}

function parseBearerToken(headerValue: string | null) {
	if (!headerValue) return null
	const match = headerValue.match(/^Bearer\s+(.+)\s*$/i)
	return match?.[1]?.trim() || null
}

function getCookieValue(cookieHeader: string | null, name: string) {
	if (!cookieHeader) return null
	for (const part of cookieHeader.split(';')) {
		const [rawKey, ...rest] = part.trim().split('=')
		if (!rawKey || rawKey !== name) continue
		return rest.join('=')
	}
	return null
}

function readAuthToken(request: Request, url: URL) {
	const bearer = parseBearerToken(request.headers.get('authorization'))
	if (bearer) return bearer
	const headerToken = request.headers.get('x-mock-token')?.trim()
	if (headerToken) return headerToken
	const urlToken = url.searchParams.get('token')?.trim()
	if (urlToken) return urlToken
	const cookieToken = getCookieValue(
		request.headers.get('cookie'),
		'mock_token',
	)
	if (cookieToken) return cookieToken
	return null
}

function isAuthorized(request: Request, env: MockGithubEnv, url: URL) {
	const expected = env.MOCK_API_TOKEN?.trim() ?? ''
	if (!expected) return true
	const provided = readAuthToken(request, url)
	return Boolean(provided && provided === expected)
}

function withTokenQueryParam(baseUrl: URL, href: string, token: string | null) {
	if (!token) return href
	const next = new URL(href, baseUrl)
	next.searchParams.set('token', token)
	return `${next.pathname}${next.search}${next.hash}`
}

function pullResponseNumber(owner: string, repo: string, pullNumber: number) {
	if (pullNumber === 42 && owner === 'kentcdodds' && repo === 'kody') {
		return json(fixturePull)
	}
	// Any repo: return a generic open PR for number 1 (smoke)
	if (pullNumber === 1) {
		return json({
			...fixturePull,
			html_url: `https://github.com/${owner}/${repo}/pull/1`,
			number: 1,
			head: {
				...fixturePull.head,
				repo: { name: repo, full_name: `${owner}/${repo}`, private: false },
			},
			base: {
				...fixturePull.base,
				repo: { name: repo, full_name: `${owner}/${repo}`, private: false },
			},
		})
	}
	return json({ message: 'Not Found', documentation_url: '' }, { status: 404 })
}

function listPulls(owner: string, repo: string, url: URL) {
	const head = url.searchParams.get('head')?.trim()
	if (head?.includes(':')) {
		return json([fixturePull])
	}
	const state = url.searchParams.get('state') ?? 'open'
	if (state === 'open' && owner === 'kentcdodds' && repo === 'kody') {
		return json([fixturePull, fixtureSecondPull])
	}
	return json([fixturePull])
}

function combinedStatus(owner: string, repo: string, ref: string) {
	void owner
	void repo
	if (ref === fixturePullHeadSha || ref.startsWith('abc123')) {
		return json(fixtureCombinedStatus)
	}
	return json({
		state: 'success',
		statuses: [],
		sha: ref,
		total_count: 0,
	})
}

function listReviews(
	owner: string,
	repo: string,
	pullNumber: number,
): Response {
	if (pullNumber === 42 && owner === 'kentcdodds' && repo === 'kody') {
		return json(fixtureReviews)
	}
	return json([])
}

function searchIssues(url: URL) {
	const q = (url.searchParams.get('q') ?? '').toLowerCase()
	const perPage = Math.min(
		100,
		Math.max(1, Number.parseInt(url.searchParams.get('per_page') ?? '10', 10)),
	)

	const items: Array<unknown> = []
	if (
		q.includes('review-requested:') ||
		q.includes('review_requested:') ||
		q.includes('review-requested:kentcdodds')
	) {
		items.push(fixtureSearchReviewRequestedPr)
	}
	if (q.includes('assignee:')) {
		items.push(fixtureSearchAssigneeIssue)
	}
	// Default combined queue when query looks like "is:open assignee"
	if (
		items.length === 0 &&
		(q.includes('assignee') || q.includes('is:issue'))
	) {
		items.push(fixtureSearchAssigneeIssue)
	}
	if (items.length === 0 && q.includes('is:pr')) {
		items.push(fixtureSearchReviewRequestedPr)
	}

	const slice = items.slice(0, perPage)
	return json({
		total_count: slice.length,
		incomplete_results: false,
		items: slice,
	})
}

async function handleGetMeta(request: Request, env: MockGithubEnv, url: URL) {
	const authorized = isAuthorized(request, env, url)
	return json({
		service: 'github',
		authorized,
		fixturePullNumber: fixturePull.number,
		endpoints: dashboardEndpoints,
	})
}

async function handleDashboard(request: Request, env: MockGithubEnv, url: URL) {
	const meta = (await handleGetMeta(request, env, url).then((res) =>
		res.json(),
	)) as { authorized: boolean }
	const tokenParam = url.searchParams.get('token')
	const dashboardToken = tokenParam?.trim() ? tokenParam.trim() : null
	const tokenHint = env.MOCK_API_TOKEN?.trim()
		? 'This mock requires a token (Authorization: Bearer ... or ?token=...).'
		: 'No token is configured; API routes are open.'

	const endpointRows = dashboardEndpoints
		.map((endpoint) => {
			const authBadge = endpoint.requiresAuth
				? '<span class="badge badge-warn">auth</span>'
				: '<span class="badge">public</span>'
			const endpointHref = withTokenQueryParam(
				url,
				endpoint.path
					.replaceAll('{owner}', 'kentcdodds')
					.replaceAll('{repo}', 'kody')
					.replaceAll('{pull_number}', '42')
					.replaceAll('{ref}', fixturePullHeadSha),
				dashboardToken,
			)
			const pathCell =
				endpoint.method === 'GET'
					? `<a href="${htmlEscape(endpointHref)}"><code>${htmlEscape(endpoint.path)}</code></a>`
					: `<code>${htmlEscape(endpoint.path)}</code>`
			return `<tr>
				<td><code>${htmlEscape(endpoint.method)}</code></td>
				<td>${pathCell}</td>
				<td>${authBadge}</td>
				<td>${htmlEscape(endpoint.description)}</td>
			</tr>`
		})
		.join('')

	const body = `<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width,initial-scale=1" />
		<title>Mock: GitHub API</title>
		<style>
			body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 0; padding: 24px; background: #f8fafc; color: #0f172a; }
			.container { max-width: 960px; margin: 0 auto; }
			h1 { font-size: 22px; margin: 0 0 8px; }
			.subtitle { color: #64748b; margin: 0 0 24px; }
			table { width: 100%; border-collapse: collapse; background: white; border-radius: 12px; overflow: hidden; border: 1px solid #e2e8f0; }
			th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #e2e8f0; }
			th { font-size: 12px; color: #64748b; }
			code { background: #f1f5f9; padding: 2px 6px; border-radius: 6px; }
			.badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; background: #e2e8f0; }
			.badge-warn { background: #fee2e2; color: #991b1b; }
			a { color: #2563eb; text-decoration: none; }
			a:hover { text-decoration: underline; }
		</style>
	</head>
	<body>
		<div class="container">
			<h1>Mock: GitHub REST</h1>
			<p class="subtitle">${htmlEscape(tokenHint)} · authorized: ${meta.authorized ? 'yes' : 'no'}</p>
			<table>
				<thead><tr><th>Method</th><th>Path</th><th>Access</th><th>Description</th></tr></thead>
				<tbody>${endpointRows}</tbody>
			</table>
			<p style="margin-top: 16px; color: #64748b; font-size: 14px;">
				Meta: <a href="${htmlEscape(withTokenQueryParam(url, '/__mocks/meta', dashboardToken))}">/__mocks/meta</a>
			</p>
		</div>
	</body>
</html>`

	return new Response(body, {
		status: 200,
		headers: { 'content-type': 'text/html; charset=utf-8' },
	})
}

function routeApi(
	request: Request,
	env: MockGithubEnv,
	url: URL,
): Response | null {
	if (!isAuthorized(request, env, url)) {
		return json(
			{ message: 'Bad credentials', documentation_url: '' },
			{ status: 401 },
		)
	}

	const pathname = url.pathname
	const mPull = pathname.match(
		/^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/reviews\/?$/,
	)
	if (request.method === 'GET' && mPull) {
		const owner = mPull[1]!
		const repo = mPull[2]!
		const num = mPull[3]!
		return listReviews(owner, repo, Number.parseInt(num, 10))
	}

	const mPullNum = pathname.match(
		/^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/?$/,
	)
	if (request.method === 'GET' && mPullNum) {
		const owner = mPullNum[1]!
		const repo = mPullNum[2]!
		const num = mPullNum[3]!
		return pullResponseNumber(owner, repo, Number.parseInt(num, 10))
	}

	const mPullsList = pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/pulls\/?$/)
	if (request.method === 'GET' && mPullsList) {
		return listPulls(mPullsList[1]!, mPullsList[2]!, url)
	}

	const mStatus = pathname.match(
		/^\/repos\/([^/]+)\/([^/]+)\/commits\/([^/]+)\/status\/?$/,
	)
	if (request.method === 'GET' && mStatus) {
		return combinedStatus(mStatus[1]!, mStatus[2]!, mStatus[3]!)
	}

	if (request.method === 'GET' && pathname === '/search/issues') {
		return searchIssues(url)
	}

	return null
}

export default {
	async fetch(request: Request, env: MockGithubEnv, ctx: ExecutionContext) {
		void ctx
		const url = new URL(request.url)

		if (request.method === 'GET' && url.pathname === '/') {
			const destination = new URL('/__mocks', url)
			destination.search = url.search
			return Response.redirect(destination.toString(), 302)
		}

		if (request.method === 'GET' && url.pathname === '/__mocks') {
			return handleDashboard(request, env, url)
		}

		if (request.method === 'GET' && url.pathname === '/__mocks/meta') {
			return handleGetMeta(request, env, url)
		}

		const apiResponse = routeApi(request, env, url)
		if (apiResponse) return apiResponse

		return new Response('Not Found', { status: 404 })
	},
} satisfies ExportedHandler<MockGithubEnv>
