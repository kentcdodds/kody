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
import { communityContentWarning } from '#mcp/capabilities/community/shared.ts'
import { callerCanAccessCapability } from '#mcp/capabilities/access-control.ts'
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
}): Promise<TestUser> {
	await ensureUsersTable()
	const userId = await createStableUserIdFromEmail(input.email)
	await runSql(
		`INSERT INTO users (username, email, stable_user_id, password_hash)
			VALUES (?, ?, ?, ?)`,
		input.username,
		input.email,
		userId,
		'test-password-hash',
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
	const queuedActivity: Array<CommunityActivityDispatchQueueMessage> = []
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
	expect(queuedActivity).toEqual([
		{
			eventId: expect.any(String),
			kind: 'fork',
			activityId: forkResult.fork_id,
		},
	])

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
	expect(ratedListing.fork_count).toBe(1)
	expect(queuedActivity).toEqual([
		{
			eventId: expect.any(String),
			kind: 'fork',
			activityId: forkResult.fork_id,
		},
		{
			eventId: expect.any(String),
			kind: 'rating',
			activityId: expect.any(String),
		},
	])
	const activity = await listCommunityActivityForAdmin({
		db: testEnv.APP_DB,
		listingId,
		pageSize: 10,
	})
	expect(activity).toMatchObject({
		total: 2,
		page: 1,
		pageSize: 10,
	})
	expect(activity.items).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				kind: 'fork',
				listingId,
				listingName: `@usera/${kodyId}`,
				listingKodyId: kodyId,
				actingUsername: 'userb',
			}),
			expect.objectContaining({
				kind: 'rating',
				listingId,
				actingUsername: 'userb',
				stars: 5,
				adaptationEffort: 1,
			}),
		]),
	)

	// Admin curation: trust pins to the reviewed commit and the effective
	// mark drops as soon as the owner republishes new content.
	expect(ratedListing.trusted).toBe(false)
	// Featuring requires trust, so it is rejected while the listing is
	// untrusted.
	await expect(
		setCommunityListingFeatured({
			env: testEnv,
			listingId,
			featured: true,
		}),
	).rejects.toThrow('Only trusted community listings can be featured')
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

	// Once trusted, featuring works and the listing shows up in the
	// onboarding starter list.
	const featuredListing = await setCommunityListingFeatured({
		env: testEnv,
		listingId,
		featured: true,
	})
	expect(featuredListing.featured).toBe(true)
	expect(featuredListing.featuredAt).toBeTruthy()
	// Re-featuring is idempotent: the original featured_at is preserved so
	// retries never reshuffle the onboarding order.
	const refeatured = await setCommunityListingFeatured({
		env: testEnv,
		listingId,
		featured: true,
	})
	expect(refeatured.featuredAt).toBe(featuredListing.featuredAt)
	const featuredRows = await listFeaturedCommunityListingsWithAggregates({
		env: testEnv,
		limit: 10,
	})
	expect(featuredRows.some((row) => row.id === listingId)).toBe(true)
	const featuredGet = await communityGetCapability.handler(
		{ listing_id: listingId },
		forkerCtx,
	)
	expect(featuredGet.featured).toBe(true)

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
	// The republish also pulls the listing from onboarding: the featured mark
	// stays stored but is no longer effective without trust.
	expect(afterRepublish.featured).toBe(false)
	const featuredAfterRepublish =
		await listFeaturedCommunityListingsWithAggregates({
			env: testEnv,
			limit: 10,
		})
	expect(featuredAfterRepublish.some((row) => row.id === listingId)).toBe(false)
	// Re-trusting the republished commit restores the stored featured mark.
	await setCommunityListingTrusted({
		env: testEnv,
		adminUserId: admin.userId,
		listingId,
		trusted: true,
	})
	const afterRetrust = await communityGetCapability.handler(
		{ listing_id: listingId },
		forkerCtx,
	)
	expect(afterRetrust.featured).toBe(true)
	// Removing the mark takes the listing out of onboarding while trusted.
	const unfeatured = await setCommunityListingFeatured({
		env: testEnv,
		listingId,
		featured: false,
	})
	expect(unfeatured.featured).toBe(false)
	expect(unfeatured.featuredAt).toBeNull()

	// Access control: only admins may reach the curation capabilities.
	expect(
		callerCanAccessCapability(
			forkerCtx.callerContext,
			communitySetTrustedCapability,
		),
	).toBe(false)
	expect(
		callerCanAccessCapability(
			forkerCtx.callerContext,
			communitySetFeaturedCapability,
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

	await expect(
		setCommunityListingFeatured({
			env: testEnv,
			listingId,
			featured: true,
		}),
	).rejects.toThrow('Delisted community listings cannot be featured.')

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

test('one-click install publishes clean listings and keeps unresolvable forks inert', async () => {
	// Publish checks and artifact rebuilds run the real worker bundler, which
	// warns that it is experimental.
	silenceIncidentalRuntimeWarnings()
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
		COMMUNITY_ACTIVITY_DISPATCH_QUEUE: {
			async send(_message: CommunityActivityDispatchQueueMessage) {
				return undefined
			},
		},
	} as Env

	const unique = crypto.randomUUID()
	const owner = await insertTestUser({
		email: `install-owner-${unique}@example.com`,
		username: 'installowner',
	})
	const installer = await insertTestUser({
		email: `installer-${unique}@example.com`,
		username: 'installer',
	})
	const ownerCtx = createCapabilityContext(testEnv, owner)

	// A listing with no cross-scope imports installs end-to-end: the fork
	// passes publish checks and immediately becomes a live saved package.
	const cleanKodyId = `install-clean-${unique}`
	await seedOwnerPackage({
		testEnv,
		owner,
		packageId: `package-clean-${unique}`,
		sourceId: `source-clean-${unique}`,
		kodyId: cleanKodyId,
		publishedCommit: `commit-clean-${unique}`,
		indexTs:
			'export default async function main() {\n\treturn { ok: true }\n}\n',
	})
	const cleanListing = await communityPublishCapability.handler(
		{ package_id: `package-clean-${unique}` },
		ownerCtx,
	)

	// A stale acknowledgement (from before a hypothetical republish) is
	// rejected before anything is forked.
	await expect(
		installCommunityListing({
			env: testEnv,
			baseUrl,
			userId: installer.userId,
			userEmail: installer.email,
			expectedPackageScope: installer.username,
			listingId: cleanListing.listing_id,
			expectedPinnedCommit: 'stale-commit-from-before-republish',
		}),
	).rejects.toThrow('republished after you confirmed')

	const installed = await installCommunityListing({
		env: testEnv,
		baseUrl,
		userId: installer.userId,
		userEmail: installer.email,
		expectedPackageScope: installer.username,
		listingId: cleanListing.listing_id,
		expectedPinnedCommit: cleanListing.pinned_commit,
	})
	expect(installed.status).toBe('installed')
	expect(installed.targetName).toBe(`@installer/${cleanKodyId}`)
	expect(await countSavedPackagesForUser(installer.userId)).toBe(1)
	const savedRow = await env.APP_DB.prepare(
		`SELECT name, kody_id, source_id
			FROM saved_packages
			WHERE user_id = ?`,
	)
		.bind(installer.userId)
		.first<{ name: string; kody_id: string; source_id: string }>()
	expect(savedRow).toEqual({
		name: `@installer/${cleanKodyId}`,
		kody_id: cleanKodyId,
		source_id: installed.sourceId,
	})

	// A listing whose code imports another user's scope cannot auto-publish:
	// the fork stays inert with the failing checks reported for follow-up.
	const messyKodyId = `install-messy-${unique}`
	await seedOwnerPackage({
		testEnv,
		owner,
		packageId: `package-messy-${unique}`,
		sourceId: `source-messy-${unique}`,
		kodyId: messyKodyId,
		publishedCommit: `commit-messy-${unique}`,
	})
	const messyListing = await communityPublishCapability.handler(
		{ package_id: `package-messy-${unique}` },
		ownerCtx,
	)

	const adaptationRequired = await installCommunityListing({
		env: testEnv,
		baseUrl,
		userId: installer.userId,
		userEmail: installer.email,
		expectedPackageScope: installer.username,
		listingId: messyListing.listing_id,
		expectedPinnedCommit: messyListing.pinned_commit,
	})
	expect(adaptationRequired.status).toBe('adaptation_required')
	if (adaptationRequired.status !== 'adaptation_required') return
	expect(adaptationRequired.crossScopeReferences).toEqual(
		expect.arrayContaining([
			{ file: 'src/index.ts', specifier: 'kody:@usera/' },
		]),
	)
	expect(adaptationRequired.failedChecks.map((check) => check.kind)).toContain(
		'bundle',
	)
	// Only the clean install produced a live package; the messy fork is inert.
	expect(await countSavedPackagesForUser(installer.userId)).toBe(1)
	const inertSource = await env.APP_DB.prepare(
		`SELECT id, user_id FROM entity_sources WHERE id = ?`,
	)
		.bind(adaptationRequired.sourceId)
		.first<{ id: string; user_id: string }>()
	expect(inertSource).toEqual({
		id: adaptationRequired.sourceId,
		user_id: installer.userId,
	})
}, 120_000)
