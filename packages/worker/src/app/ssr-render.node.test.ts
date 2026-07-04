import { expect, test, vi } from 'vitest'
import { type CommunityListingWithAggregates } from '#worker/community/types.ts'
import {
	createAuthCookie,
	setAuthSessionSecret,
	type AuthSession,
} from '#app/auth-session.ts'
import { createAccountHandler } from '#app/handlers/account.ts'
import { createCommunityHandler } from '#app/handlers/community.tsx'
import { createResetPasswordHandler } from '#app/handlers/reset-password.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { resetDataCacheForTests } from '#app/data-cache.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

const communityMockModule = vi.hoisted(() => ({
	listCommunityListingsWithAggregates: vi.fn(),
	searchCommunityListings: vi.fn(),
}))

vi.mock('#worker/community/service.ts', () => ({
	listCommunityListingsWithAggregates: (...args: Array<unknown>) =>
		communityMockModule.listCommunityListingsWithAggregates(...args),
	searchCommunityListings: (...args: Array<unknown>) =>
		communityMockModule.searchCommunityListings(...args),
	getCommunityListingWithAggregates: vi.fn(),
	reportCommunityListing: vi.fn(),
}))

const sampleListing = {
	id: 'listing-1',
	ownerUserId: 'owner-mcp-id',
	packageId: 'pkg-1',
	sourceId: 'src-1',
	kodyId: 'github-triage',
	name: '@kentcdodds/github-triage',
	description: 'Triage GitHub issues.',
	tags: ['github'],
	searchText: null,
	readmeContent: '# README',
	license: 'MIT',
	pinnedCommit: 'abc1234567890',
	status: 'active',
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-01T00:00:00.000Z',
	publishedAt: '2026-01-01T00:00:00.000Z',
	averageStars: 4.5,
	ratingCount: 2,
	averageAdaptationEffort: 3,
	forkCount: 1,
} satisfies CommunityListingWithAggregates

type TestUser = {
	id: number
	email: string
	username: string
	password_hash: string
	created_at: string
	updated_at: string
}

function createUserTestDb(users: Array<TestUser>) {
	const userRecords = new Map(users.map((user) => [user.id, { ...user }]))
	return {
		prepare(query: string) {
			const normalizedQuery = query.replace(/\s+/g, ' ').trim().toLowerCase()
			return {
				bind(...params: Array<unknown>) {
					const executeAll = async () => {
						if (
							normalizedQuery.startsWith('select') &&
							normalizedQuery.includes('from "users"') &&
							/"id"\s*=/.test(normalizedQuery)
						) {
							const user = userRecords.get(Number(params[0]))
							return {
								results: user ? [{ ...user }] : [],
								meta: { changes: 0, last_row_id: 0 },
							}
						}
						if (normalizedQuery.includes('from user_roles')) {
							return {
								results: [],
								meta: { changes: 0, last_row_id: 0 },
							}
						}
						return {
							results: [],
							meta: { changes: 0, last_row_id: 0 },
						}
					}
					return {
						async all() {
							return executeAll()
						},
						async first() {
							const result = await executeAll()
							return result.results[0] ?? null
						},
						async run() {
							return { meta: { changes: 0, last_row_id: 0 } }
						},
					}
				},
			}
		},
		async exec() {
			return
		},
	} as unknown as D1Database
}

function createTestEnv(db: D1Database) {
	return {
		COOKIE_SECRET: testCookieSecret,
		SECRET_STORE_KEY: 'LOCAL_TEST_SECRET_STORE_KEY_32_CHARS_MINIMUM',
		APP_DB: db,
		BUNDLE_ARTIFACTS_KV: {},
		JOB_MANAGER: {},
		STORAGE_RUNNER: {},
		PACKAGE_REALTIME_SESSION: {},
		PACKAGE_SERVICE_INSTANCE: {},
	} as unknown as Env
}

async function readResponseText(response: Response) {
	return await response.text()
}

function parseRmxData(html: string) {
	const match = html.match(
		/<script type="application\/json" id="rmx-data">([\s\S]*?)<\/script>/,
	)
	if (!match?.[1]) {
		throw new Error('rmx-data script not found in HTML response')
	}
	return JSON.parse(match[1]) as {
		h: Record<
			string,
			{
				props: {
					url: string
					session: unknown
					loaderData?: Record<string, unknown>
					notFound?: boolean
				}
			}
		>
	}
}

function readAppRootProps(html: string) {
	const rmxData = parseRmxData(html)
	const entry = Object.values(rmxData.h)[0]
	if (!entry) {
		throw new Error('AppRoot hydration entry not found in rmx-data')
	}
	return entry.props
}

async function runHtmlHandler(
	handler: { handler: (context: never) => Promise<Response> },
	request: Request,
) {
	return handler.handler({
		request,
		url: new URL(request.url),
		params: {},
	} as never)
}

test('SSR HTML routes render page content and embedded loader data', async () => {
	resetDataCacheForTests()
	setAuthSessionSecret(testCookieSecret)
	const env = createTestEnv(
		createUserTestDb([
			{
				id: 1,
				email: 'user@example.com',
				username: 'account-user',
				password_hash: 'unused',
				created_at: new Date(0).toISOString(),
				updated_at: new Date(0).toISOString(),
			},
		]),
	)

	communityMockModule.listCommunityListingsWithAggregates.mockResolvedValue([
		sampleListing,
	])

	const communityResponse = await runHtmlHandler(
		createCommunityHandler(env),
		new Request('https://example.com/community'),
	)
	expect(communityResponse.status).toBe(200)
	expect(communityResponse.headers.get('Content-Type')).toContain('text/html')
	const communityHtml = await readResponseText(communityResponse)
	expect(communityHtml).toContain('@kentcdodds/github-triage')
	expect(communityHtml).toContain('Triage GitHub issues.')
	expect(communityHtml).toContain('data-testid="community-listings-frame"')
	expect(communityHtml).not.toContain('Loading community packages')
	expect(communityHtml).toContain('<!-- rmx:h:')
	const communityProps = readAppRootProps(communityHtml)
	expect(communityProps.loaderData?.community).toBeUndefined()

	const communityFrameResponse = await runHtmlHandler(
		createCommunityHandler(env),
		new Request('https://example.com/community', {
			headers: { 'x-remix-target': 'community-listings' },
		}),
	)
	expect(communityFrameResponse.status).toBe(200)
	expect(communityFrameResponse.headers.get('Cache-Control')).toBe('no-store')
	const communityFrameHtml = await readResponseText(communityFrameResponse)
	expect(communityFrameHtml).toContain('data-testid="community-listings-frame"')
	expect(communityFrameHtml).toContain('@kentcdodds/github-triage')
	expect(communityFrameHtml).not.toContain('<html')

	const accountCookie = await createAuthCookie(
		{
			id: '1',
			email: 'user@example.com',
			rememberMe: false,
		} satisfies AuthSession,
		false,
	)
	const accountResponse = await runHtmlHandler(
		createAccountHandler(env),
		new Request('https://example.com/account', {
			headers: { Cookie: accountCookie },
		}),
	)
	expect(accountResponse.status).toBe(200)
	const accountHtml = await readResponseText(accountResponse)
	expect(accountHtml).toContain('account-user account')
	expect(accountHtml).toContain('Email: user@example.com')
	expect(accountHtml).not.toContain('Loading account')
	const accountProps = readAppRootProps(accountHtml)
	expect(accountProps.loaderData?.accountProfile).toEqual({
		ok: true,
		email: 'user@example.com',
		username: 'account-user',
		displayName: 'account-user',
	})

	const anonymousAccountResponse = await runHtmlHandler(
		createAccountHandler(env),
		new Request('https://example.com/account'),
	)
	expect(anonymousAccountResponse.status).toBe(302)
	expect(anonymousAccountResponse.headers.get('Location')).toBe(
		'https://example.com/login?redirectTo=%2Faccount',
	)

	const notFoundResponse = await renderAppPage({
		request: new Request('https://example.com/missing-page'),
		env,
		title: 'Not found',
		notFound: true,
		status: 404,
	})
	expect(notFoundResponse.status).toBe(404)
	const notFoundHtml = await readResponseText(notFoundResponse)
	expect(notFoundHtml).toContain('Not Found')
	expect(readAppRootProps(notFoundHtml).notFound).toBe(true)

	const resetConfirmResponse = await runHtmlHandler(
		createResetPasswordHandler(env),
		new Request('https://example.com/reset-password?token=reset-token'),
	)
	expect(resetConfirmResponse.status).toBe(200)
	const resetConfirmHtml = await readResponseText(resetConfirmResponse)
	expect(resetConfirmHtml).toContain('Choose a new password')
	expect(resetConfirmHtml).toContain('New password')
	expect(resetConfirmHtml).not.toContain('Send reset link')
	expect(readAppRootProps(resetConfirmHtml).url).toBe(
		'/reset-password?token=reset-token',
	)
})
