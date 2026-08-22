import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { communityForkCapability } from '#mcp/capabilities/community/fork.ts'
import { communityGetCapability } from '#mcp/capabilities/community/get.ts'
import { communityPublishCapability } from '#mcp/capabilities/community/publish.ts'
import { communityRateCapability } from '#mcp/capabilities/community/rate.ts'
import { communityReportCapability } from '#mcp/capabilities/community/report.ts'
import { communitySearchCapability } from '#mcp/capabilities/community/search.ts'
import { communitySetFeaturedCapability } from '#mcp/capabilities/community/set-featured.ts'
import { communitySetTrustedCapability } from '#mcp/capabilities/community/set-trusted.ts'
import { communityUnpublishCapability } from '#mcp/capabilities/community/unpublish.ts'
import { communityContentWarning } from '#mcp/capabilities/community/shared.ts'
import { getPackageCapability } from '#mcp/capabilities/packages/get-package.ts'
import { listPackagesCapability } from '#mcp/capabilities/packages/list-packages.ts'
import { callerCanAccessCapability } from '#mcp/capabilities/access-control.ts'
import { CommunityActionError } from '#worker/community/errors.ts'
import {
	banCommunityUser,
	listFeaturedCommunityListingsWithAggregates,
	listCommunityActivityForAdmin,
	resolveCommunityReport,
	setCommunityListingFeatured,
	setCommunityListingTrusted,
} from '#worker/community/service.ts'
import { installCommunityListing } from '#worker/community/install.ts'
import { insertSavedPackage } from '#worker/package-registry/repo.ts'
import { writePublishedSourceSnapshot } from '#worker/package-runtime/published-runtime-artifacts.ts'
import { insertEntitySource } from '#worker/repo/entity-sources.ts'
import { type EntitySourceRow } from '#worker/repo/types.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { createArtifactsMswHandlers } from '#worker/test-support/artifacts-msw-handlers.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import { type CommunityActivityDispatchQueueMessage } from './activity-dispatch-queue-producer.ts'
import { createMswNodeServer } from '#worker/test-support/msw-node-server.ts'
import { ensureCommunityFlowSchema } from './community-flow-test-schema.ts'

const mockAccountId = 'cf_account_mock_123'
const artifactsApiBaseUrl = 'https://artifacts-mock.test'
const baseUrl = 'https://test.kody.dev'

type TestUser = {
	userId: string
	email: string
	username: string
	displayName: string
}

async function runSql(sql: string, ...values: Array<unknown>) {
	await env.APP_DB.prepare(sql)
		.bind(...values)
		.run()
}

async function ensureUsersTable() {
	await ensureCommunityFlowSchema(env.APP_DB)
}

async function insertTestUser(input: {
	email: string
	username: string
	accountType?: 'person' | 'platform'
}): Promise<TestUser> {
	await ensureUsersTable()
	const userId = await createStableUserIdFromEmail(input.email)
	await runSql(
		`INSERT INTO users (username, email, stable_user_id, password_hash, plan, account_type)
			VALUES (?, ?, ?, ?, ?, ?)`,
		input.username,
		input.email,
		userId,
		'test-password-hash',
		'max',
		input.accountType ?? 'person',
	)
	return {
		userId,
		email: input.email,
		username: input.username,
		displayName: input.username,
	}
}

function createCapabilityContext(testEnv: Env, user: TestUser) {
	return {
		env: testEnv,
		callerContext: createMcpCallerContext({
			baseUrl,
			user: {
				userId: user.userId,
				email: user.email,
				username: user.username,
				displayName: user.displayName,
			},
		}),
	}
}

async function countSavedPackagesForUser(userId: string) {
	const row = await env.APP_DB.prepare(
		`SELECT COUNT(*) AS count
			FROM saved_packages
			WHERE user_id = ?`,
	)
		.bind(userId)
		.first<{ count: number }>()
	return row?.count ?? 0
}

async function seedOwnerPackage(input: {
	testEnv: Env
	owner: TestUser
	packageId: string
	sourceId: string
	kodyId: string
	publishedCommit: string
	indexTs?: string
}) {
	const packageName = `@${input.owner.username}/${input.kodyId}`
	const packageJson = `${JSON.stringify(
		{
			name: packageName,
			license: 'MIT',
			exports: { '.': './src/index.ts' },
			kody: {
				id: input.kodyId,
				description: 'Community flow integration test package',
			},
		},
		null,
		'\t',
	)}\n`
	const readme =
		'# Community Flow Package\n\n## Intent\n\nDemonstrate community publishing and forking.\n'
	const indexTs =
		input.indexTs ??
		`import { value } from 'kody:@usera/shared-utils/index'\n\nexport default async function main() {\n\treturn { ok: true, value }\n}\n`
	const files = {
		'package.json': packageJson,
		'README.md': readme,
		'src/index.ts': indexTs,
	}
	const now = new Date().toISOString()

	await insertSavedPackage(env.APP_DB, {
		id: input.packageId,
		user_id: input.owner.userId,
		name: packageName,
		kody_id: input.kodyId,
		description: 'Community flow integration test package',
		tags_json: JSON.stringify(['community', 'integration']),
		search_text: 'community flow integration websocket',
		source_id: input.sourceId,
		has_app: 0,
		hidden: 0,
		is_private: 0,
		created_at: now,
		updated_at: now,
	})

	const entitySource: EntitySourceRow = {
		id: input.sourceId,
		user_id: input.owner.userId,
		entity_kind: 'package',
		entity_id: input.packageId,
		repo_id: `package-${input.packageId}`,
		published_commit: input.publishedCommit,
		indexed_commit: null,
		manifest_path: 'package.json',
		source_root: '/',
		last_external_check_at: null,
		external_check_until: null,
		created_at: now,
		updated_at: now,
	}
	await insertEntitySource(env.APP_DB, entitySource)
	await writePublishedSourceSnapshot({
		env: input.testEnv,
		source: entitySource,
		files,
	})
	return { entitySource, files }
}

test('community package flow works end-to-end through capability handlers', async () => {
	silenceIncidentalRuntimeWarnings()
	using _artifactsMock = createMswNodeServer(
		createArtifactsMswHandlers({
			accountId: mockAccountId,
			apiBaseUrl: artifactsApiBaseUrl,
		}),
		{ onUnhandledRequest: 'bypass' },
	)
	const queuedActivity: Array<CommunityActivityDispatchQueueMessage> = []
	const queuedListingPublished: Array<{ eventId: string; listingId: string }> =
		[]
	const testEnv = {
		...env,
		CLOUDFLARE_ACCOUNT_ID: mockAccountId,
		CLOUDFLARE_API_TOKEN: 'artifacts-test-token',
		CLOUDFLARE_API_BASE_URL: artifactsApiBaseUrl,
		COMMUNITY_ACTIVITY_DISPATCH_QUEUE: {
			async send(message: CommunityActivityDispatchQueueMessage) {
				queuedActivity.push(message)
			},
		},
		COMMUNITY_LISTING_PUBLISHED_DISPATCH_QUEUE: {
			async send(message: { eventId: string; listingId: string }) {
				queuedListingPublished.push(message)
			},
		},
	} as Env

	const unique = crypto.randomUUID()
	const owner = await insertTestUser({
		email: `owner-a-${unique}@example.com`,
		username: 'usera',
	})
	const forker = await insertTestUser({
		email: `forker-b-${unique}@example.com`,
		username: 'userb',
	})
	const reporter = await insertTestUser({
		email: `reporter-c-${unique}@example.com`,
		username: 'userc',
	})
	const admin = await insertTestUser({
		email: `admin-${unique}@example.com`,
		username: 'admin',
	})

	const packageId = `package-${unique}`
	const sourceId = `source-${unique}`
	const kodyId = `community-flow-${unique}`
	const publishedCommit = `commit-${unique}`

	const seeded = await seedOwnerPackage({
		testEnv,
		owner,
		packageId,
		sourceId,
		kodyId,
		publishedCommit,
	})

	const ownerCtx = createCapabilityContext(testEnv, owner)
	const forkerCtx = createCapabilityContext(testEnv, forker)
	const reporterCtx = createCapabilityContext(testEnv, reporter)

	const publishResult = await communityPublishCapability.handler(
		{ package_id: packageId },
		ownerCtx,
	)
	expect(publishResult).toMatchObject({
		name: `@usera/${kodyId}`,
		kody_id: kodyId,
		license: 'MIT',
		status: 'active',
		pinned_commit: publishedCommit,
		public_url: `${baseUrl}/@usera/${kodyId}`,
	})
	const listingId = publishResult.listing_id
	expect(queuedListingPublished).toEqual([
		expect.objectContaining({
			listingId,
			eventId: expect.any(String),
		}),
	])
	queuedListingPublished.length = 0

	const searchResult = await communitySearchCapability.handler(
		{ query: 'community flow integration', limit: 10 },
		forkerCtx,
	)
	expect(searchResult.outcome).toBe('matches')
	expect(
		searchResult.matches.some((match) => match.listing_id === listingId),
	).toBe(true)
	expect(
		searchResult.matches.find((match) => match.listing_id === listingId)
			?.relevance,
	).toBeGreaterThanOrEqual(0.2)
	expect(
		searchResult.matches.find((match) => match.listing_id === listingId)
			?.public_url,
	).toBe(`${baseUrl}/@usera/${kodyId}`)

	const getResult = await communityGetCapability.handler(
		{ listing_id: listingId },
		forkerCtx,
	)
	expect(getResult.readme_untrusted).toContain('## Intent')
	expect