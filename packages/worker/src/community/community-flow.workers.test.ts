import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { communityForkCapability } from '#mcp/capabilities/community/fork.ts'
import { communityGetCapability } from '#mcp/capabilities/community/get.ts'
import { communityPublishCapability } from '#mcp/capabilities/community/publish.ts'
import { communityRateCapability } from '#mcp/capabilities/community/rate.ts'
import { communityReportCapability } from '#mcp/capabilities/community/report.ts'
import { communitySearchCapability } from '#mcp/capabilities/community/search.ts'
import { communitySetTrustedCapability } from '#mcp/capabilities/community/set-trusted.ts'
import { communityContentWarning } from '#mcp/capabilities/community/shared.ts'
import { callerCanAccessCapability } from '#mcp/capabilities/access-control.ts'
import {
	banCommunityUser,
	resolveCommunityReport,
	setCommunityListingTrusted,
} from '#worker/community/service.ts'
import { insertSavedPackage } from '#worker/package-registry/repo.ts'
import { writePublishedSourceSnapshot } from '#worker/package-runtime/published-runtime-artifacts.ts'
import { insertEntitySource } from '#worker/repo/entity-sources.ts'
import { type EntitySourceRow } from '#worker/repo/types.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { createArtifactsMswHandlers } from '#worker/test-support/artifacts-msw-handlers.ts'
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
}): Promise<TestUser> {
	await ensureUsersTable()
	await runSql(
		`INSERT INTO users (username, email, password_hash)
			VALUES (?, ?, ?)`,
		input.username,
		input.email,
		'test-password-hash',
	)
	return {
		userId: await createStableUserIdFromEmail(input.email),
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
	const indexTs = `import { value } from 'kody:@usera/shared-utils/index'\n\nexport default async function main() {\n\treturn { ok: true, value }\n}\n`
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
	using _artifactsMock = createMswNodeServer(
		createArtifactsMswHandlers({
			accountId: mockAccountId,
			apiBaseUrl: artifactsApiBaseUrl,
		}),
		{ onUnhandledRequest: 'bypass' },
	)
	const testEnv = {
		...env,
		CLOUDFLARE_ACCOUNT_ID: mockAccountId,
		CLOUDFLARE_API_TOKEN: 'artifacts-test-token',
		CLOUDFLARE_API_BASE_URL: artifactsApiBaseUrl,
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
	})
	const listingId = publishResult.listing_id

	const searchResult = await communitySearchCapability.handler(
		{ query: 'community flow integration', limit: 10 },
		forkerCtx,
	)
	expect(
		searchResult.matches.some((match) => match.listing_id === listingId),
	).toBe(true)

	const getResult = await communityGetCapability.handler(
		{ listing_id: listingId },
		forkerCtx,
	)
	expect(getResult.readme_untrusted).toContain('## Intent')
	expect(getResult.content_warning).toBe(communityContentWarning)

	const forkResult = await communityForkCapability.handler(
		{ listing_id: listingId },
		forkerCtx,
	)
	expect(forkResult.target_name).toBe(`@userb/${kodyId}`)
	expect(forkResult.cross_scope_references).toEqual(
		expect.arrayContaining([
			{ file: 'src/index.ts', specifier: 'kody:@usera/' },
		]),
	)
	expect(await countSavedPackagesForUser(forker.userId)).toBe(0)

	const forkedSource = await env.APP_DB.prepare(
		`SELECT id, user_id, entity_id, published_commit
				FROM entity_sources
				WHERE id = ?`,
	)
		.bind(forkResult.source_id)
		.first<{
			id: string
			user_id: string
			entity_id: string
			published_commit: string | null
		}>()
	expect(forkedSource).toMatchObject({
		id: forkResult.source_id,
		user_id: forker.userId,
		entity_id: forkResult.package_id,
	})
	expect(forkedSource?.published_commit).toBeTruthy()

	await expect(
		communityRateCapability.handler(
			{
				listing_id: listingId,
				stars: 4,
				adaptation_effort: 2,
			},
			reporterCtx,
		),
	).rejects.toThrow('rate after forking')

	await communityRateCapability.handler(
		{
			listing_id: listingId,
			stars: 5,
			adaptation_effort: 1,
			note: 'Easy to adapt',
		},
		forkerCtx,
	)

	const ratedListing = await communityGetCapability.handler(
		{ listing_id: listingId },
		forkerCtx,
	)
	expect(ratedListing.rating_count).toBe(1)
	expect(ratedListing.average_stars).toBe(5)

	// Admin curation: trust pins to the reviewed commit and the effective
	// mark drops as soon as the owner republishes new content.
	expect(ratedListing.trusted).toBe(false)
	const trustedListing = await setCommunityListingTrusted({
		env: testEnv,
		adminUserId: admin.userId,
		listingId,
		trusted: true,
	})
	expect(trustedListing.trusted).toBe(true)
	expect(trustedListing.trustedCommit).toBe(publishedCommit)
	const trustedGet = await communityGetCapability.handler(
		{ listing_id: listingId },
		forkerCtx,
	)
	expect(trustedGet.trusted).toBe(true)

	const republishedCommit = `commit-republished-${unique}`
	await writePublishedSourceSnapshot({
		env: testEnv,
		source: { ...seeded.entitySource, published_commit: republishedCommit },
		files: seeded.files,
	})
	await runSql(
		`UPDATE entity_sources SET published_commit = ? WHERE id = ?`,
		republishedCommit,
		sourceId,
	)
	const republishResult = await communityPublishCapability.handler(
		{ package_id: packageId },
		ownerCtx,
	)
	expect(republishResult.pinned_commit).toBe(republishedCommit)
	const afterRepublish = await communityGetCapability.handler(
		{ listing_id: listingId },
		forkerCtx,
	)
	expect(afterRepublish.trusted).toBe(false)

	// Access control: only admins may reach community_set_trusted.
	expect(
		callerCanAccessCapability(
			forkerCtx.callerContext,
			communitySetTrustedCapability,
		),
	).toBe(false)

	const reportResult = await communityReportCapability.handler(
		{
			listing_id: listingId,
			reason: 'Suspicious instructions in README',
		},
		reporterCtx,
	)
	expect(reportResult.status).toBe('open')

	await resolveCommunityReport({
		env: testEnv,
		adminUserId: admin.userId,
		reportId: reportResult.report_id,
		action: 'delist',
		resolutionNote: 'Confirmed policy violation',
	})

	await expect(
		communityGetCapability.handler({ listing_id: listingId }, forkerCtx),
	).rejects.toThrow('Community listing not found.')

	await expect(
		communityPublishCapability.handler({ package_id: packageId }, ownerCtx),
	).rejects.toThrow('was delisted by an admin and cannot be re-published')

	await expect(
		setCommunityListingTrusted({
			env: testEnv,
			adminUserId: admin.userId,
			listingId,
			trusted: true,
		}),
	).rejects.toThrow('Delisted community listings cannot be marked trusted.')

	await banCommunityUser({
		env: testEnv,
		adminUserId: admin.userId,
		userId: reporter.userId,
		reason: 'Repeated abusive reports',
	})

	await expect(
		communityReportCapability.handler(
			{
				listing_id: listingId,
				reason: 'Trying again after ban',
			},
			reporterCtx,
		),
	).rejects.toThrow('banned from community participation')
}, 120_000)
