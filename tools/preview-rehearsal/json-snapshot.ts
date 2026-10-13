import { buildPackageAppUrl } from '@kody-internal/shared/public-urls.ts'
import {
	openRehearsalSession,
	type OpenRehearsalSession,
	type RehearsalSession,
} from './kody-session.ts'
import {
	rehearsalOrg,
	type RehearsalOrigins,
	type RehearsalUser,
} from './rehearsal-env.ts'
import {
	appMarker,
	memoryQueries,
	personalPackageLeaf,
} from './rehearsal-packages.ts'
import {
	callCapability,
	credentialGranteeProofs,
	integrationProofModule,
	packageExportModule,
	userSecretProofModule,
} from './seed.ts'

export type SnapshotUser = {
	role: RehearsalUser['role']
	email: string
	username: string
	/**
	 * Personal org slug for `?org=` on consent. Migrated orgs keep the
	 * signup username forever, so this stays `rh-dave` after dave renames.
	 */
	orgSlug: string
	password: string
}

/**
 * Keys that change on every read or every job tick. Dropped so two snapshots
 * of an idle preview diff clean; job schedules keep `next_run_at`.
 */
const volatileKeyPattern =
	/^(last_[a-z_]+|lastUsedAt|updated_at|updatedAt|serverTiming|alarm|timing|phase_timings|warning|warnings|mutation_guidance|day|weekStart)$/

export function stripVolatile(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stripVolatile)
	if (!value || typeof value !== 'object') return value
	const out: Record<string, unknown> = {}
	for (const [key, entry] of Object.entries(value)) {
		if (volatileKeyPattern.test(key)) continue
		out[key] = stripVolatile(entry)
	}
	return out
}

/**
 * The inline app path on previews intermittently answers 500 or a login
 * redirect for a valid session; a persistent failure still shows up.
 */
const appAttempts = 3
const appRetryDelayMs = 2_000
const sleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms))

/** MCP errors carry a per-call conversation id. */
function normalizeErrorMessage(message: string) {
	return message.replace(/conversationId: \S+/g, 'conversationId: <id>')
}

type SnapshotCheckFailure = { check: string; error: string }

type Capture = (check: string, fn: () => Promise<unknown>) => Promise<unknown>

/**
 * Every captured read is a required check: a failure is kept in the snapshot
 * for diagnosis and listed in `failures`, so the run fails even when the
 * before and after snapshots fail identically.
 */
function createCapture(failures: Array<SnapshotCheckFailure>): Capture {
	return async (check, fn) => {
		try {
			return stripVolatile(await fn())
		} catch (error) {
			const message = normalizeErrorMessage(
				error instanceof Error ? error.message : String(error),
			)
			failures.push({ check, error: message })
			return { error: message }
		}
	}
}

function memoryMatchesSummary(result: unknown) {
	const matches = (result as { matches?: Array<Record<string, unknown>> })
		?.matches
	if (!Array.isArray(matches)) return result
	return matches.map((match) => ({
		id: match.id ?? match.memory_id ?? null,
		subject: match.subject ?? null,
	}))
}

async function snapshotPerson(
	session: RehearsalSession,
	user: SnapshotUser,
	origins: RehearsalOrigins,
	capture: Capture,
) {
	const check = (name: string) => `${user.role}.${name}`
	const echoUrl = `${origins.mockCloudflare}/__mocks/rehearsal/echo`
	const packageName = `@${user.username}/${personalPackageLeaf}`
	const appUrl = buildPackageAppUrl({
		origin: origins.app,
		username: user.username,
		kodyId: personalPackageLeaf,
	})
	const memorySearches: Record<string, unknown> = {}
	for (const query of memoryQueries) {
		memorySearches[query] = await capture(
			check(`memorySearch:${query}`),
			async () =>
				memoryMatchesSummary(
					await callCapability(session, 'metaMemorySearch', {
						query,
						limit: 3,
					}),
				),
		)
	}
	return {
		role: user.role,
		me: await capture(check('me'), () =>
			callCapability(session, 'metaGetCurrentUser'),
		),
		packages: await capture(check('packages'), () =>
			callCapability(session, 'packageList'),
		),
		appUrl,
		app: await capture(check('app'), async () => {
			let attempt = 0
			for (;;) {
				attempt += 1
				try {
					const response = await session.request(new URL(appUrl).pathname)
					const servesApp =
						typeof response.body === 'string' &&
						response.body.includes(appMarker)
					if (servesApp || attempt === appAttempts) {
						return { status: response.status, servesApp }
					}
				} catch (error) {
					if (attempt === appAttempts) throw error
				}
				await sleep(appRetryDelayMs)
			}
		}),
		jobs: await capture(check('jobs'), async () => {
			const listed = (await callCapability(session, 'jobList')) as {
				jobs?: Array<Record<string, unknown>>
			}
			return (listed.jobs ?? []).map((job) => ({
				id: job.id,
				name: job.name,
				enabled: job.enabled,
				schedule_summary: job.schedule_summary,
				next_run_at: job.next_run_at ?? null,
			}))
		}),
		webhooks: await capture(check('webhooks'), () =>
			callCapability(session, 'webhookList'),
		),
		secrets: await capture(check('secrets'), () =>
			callCapability(session, 'secretList'),
		),
		secretProofs: {
			user: await capture(check('secretProof.user'), () =>
				session.execute(userSecretProofModule(echoUrl)),
			),
			package: await capture(check('secretProof.package'), () =>
				session.execute(
					packageExportModule(`kody:${packageName}/secret-proof`),
				),
			),
		},
		integrations: await capture(check('integrations'), () =>
			callCapability(session, 'integrationList'),
		),
		integrationProof: await capture(check('integrationProof'), () =>
			session.execute(integrationProofModule(echoUrl)),
		),
		memorySearches,
		grants: await capture(check('grants'), () =>
			callCapability(session, 'accessList'),
		),
		tokens: await capture(check('tokens'), async () => {
			const listed = (await session.api('tokenList')) as {
				tokens?: Array<Record<string, unknown>>
			}
			return (listed?.tokens ?? []).map((token) => ({
				id: token.id,
				name: token.name,
				scopes: token.scopes,
			}))
		}),
		/**
		 * Not compared by `diffSnapshots`: every snapshot's own execute calls
		 * (and job runs) move the counters.
		 */
		observed: {
			usage: await capture(check('usage'), () =>
				callCapability(session, 'usageGet'),
			),
		},
	}
}

async function captureOpenFailure(
	capture: Capture,
	check: string,
	error: unknown,
) {
	return {
		session: await capture(check, async () => {
			throw error
		}),
	}
}

/**
 * The org owner's MCP connection binds to the rehearsal org only while the
 * owner membership is live; its package list is the org's, not the owner's.
 */
async function snapshotOrg(session: RehearsalSession, capture: Capture) {
	const check = (name: string) => `org.${name}`
	return {
		slug: rehearsalOrg.slug,
		me: await capture(check('me'), () =>
			callCapability(session, 'metaGetCurrentUser'),
		),
		packages: await capture(check('packages'), () =>
			callCapability(session, 'packageList'),
		),
		grants: await capture(check('grants'), () =>
			callCapability(session, 'accessList'),
		),
	}
}

/**
 * carol, bound to alice's org, uses alice's user secret and integration
 * through her per-credential Use grants. Both proofs must match alice's own,
 * so a migration that drops or mis-keys those grants records a failure.
 */
async function snapshotCredentialGrantee(
	session: RehearsalSession,
	ownerSession: RehearsalSession,
	grantee: SnapshotUser,
	owner: SnapshotUser,
	origins: RehearsalOrigins,
	capture: Capture,
) {
	const check = (name: string) => `grantee.${name}`
	return {
		grantee: grantee.role,
		org: owner.orgSlug,
		proofs: await capture(check('credentialProofs'), () =>
			credentialGranteeProofs({
				grantee: session,
				owner: ownerSession,
				echoUrl: `${origins.mockCloudflare}/__mocks/rehearsal/echo`,
			}),
		),
	}
}

function listedPackageIds(listing: unknown) {
	const packages = (listing as { packages?: unknown } | null)?.packages
	if (!Array.isArray(packages)) return []
	return packages.flatMap((pkg) => {
		const id = (pkg as { id?: unknown } | null)?.id
		return typeof id === 'string' ? [id] : []
	})
}

/**
 * Package ids that show up in more than one owner's `packageList`. Each org
 * lists only the packages it owns, so any hit is a package injected from
 * another account (the old platform-account lane).
 */
export function findPackagesListedByMoreThanOneOwner(
	listings: Record<string, unknown>,
) {
	const ownersById = new Map<string, Array<string>>()
	for (const [owner, listing] of Object.entries(listings)) {
		for (const id of new Set(listedPackageIds(listing))) {
			ownersById.set(id, [...(ownersById.get(id) ?? []), owner])
		}
	}
	return [...ownersById]
		.filter(([, owners]) => owners.length > 1)
		.map(([id, owners]) => ({ id, owners }))
}

type SnapshotOpenFailure = { session: unknown }

export type JsonSnapshot = {
	version: 1
	takenAt: string
	origins: RehearsalOrigins
	admin: Record<string, unknown>
	people: Array<Awaited<ReturnType<typeof snapshotPerson>>>
	org:
		| Awaited<ReturnType<typeof snapshotOrg>>
		| ({ slug: typeof rehearsalOrg.slug } & SnapshotOpenFailure)
	grantee:
		| Awaited<ReturnType<typeof snapshotCredentialGrantee>>
		| SnapshotOpenFailure
	failures: Array<SnapshotCheckFailure>
}

/**
 * §12.2 step 3 through Kody's own JSON surfaces (MCP execute/api plus the
 * session routes), signed in as each rehearsal user. Runs anywhere the
 * credentials are available: the workflow derives them, an operator passes
 * the opened credentials file.
 */
export async function takeJsonSnapshot(input: {
	origins: RehearsalOrigins
	users: ReadonlyArray<SnapshotUser>
	now?: () => Date
	log?: (line: string) => void
	openSession?: OpenRehearsalSession
}): Promise<JsonSnapshot> {
	const log = input.log ?? (() => {})
	const openSession = input.openSession ?? openRehearsalSession
	const adminUser = input.users.find((user) => user.role === 'admin')
	if (!adminUser)
		throw new Error('Snapshot needs the rehearsal admin credentials.')
	const failures: Array<SnapshotCheckFailure> = []
	const capture = createCapture(failures)
	// Bind every session to an org. After P8, users who also own another org
	// (for example bob after a scope-grant conversion) must pass ?org= or
	// consent refuses with "Choose an organization".
	//
	// Each open is POST /auth + POST /oauth/authorize, and those share the
	// per-IP 10/60s auth bucket. Reuse person cookies for later org-bound
	// connections, and reuse alice's person session for the grantee owner
	// proofs, so a single snapshot stays under the limit.
	const admin = await openSession(input.origins.app, adminUser, {
		orgSlug: adminUser.orgSlug,
	})
	const adminView: Record<string, unknown> = {}
	try {
		for (const user of input.users) {
			adminView[user.role] = {
				user: await capture(`admin.${user.role}.user`, () =>
					callCapability(admin, 'adminUserGet', { email: user.email }),
				),
				wallet: await capture(`admin.${user.role}.wallet`, () =>
					callCapability(admin, 'adminCreditWalletGet', { email: user.email }),
				),
			}
		}
	} finally {
		await admin.close()
	}
	const opened: Array<RehearsalSession> = []
	const personSessions = new Map<SnapshotUser['role'], RehearsalSession>()
	try {
		const people: JsonSnapshot['people'] = []
		for (const user of input.users.filter((entry) => entry.role !== 'admin')) {
			log(`Snapshotting ${user.role}...`)
			const session = await openSession(input.origins.app, user, {
				orgSlug: user.orgSlug,
			})
			opened.push(session)
			personSessions.set(user.role, session)
			people.push(await snapshotPerson(session, user, input.origins, capture))
		}
		const orgOwner = input.users.find(
			(user) => user.role === rehearsalOrg.owner,
		)
		if (!orgOwner) {
			throw new Error(
				`Snapshot needs the rehearsal org owner (${rehearsalOrg.owner}) credentials.`,
			)
		}
		log(`Snapshotting @${rehearsalOrg.slug} as ${orgOwner.role}...`)
		let org: JsonSnapshot['org']
		try {
			const orgSession = await openSession(input.origins.app, orgOwner, {
				orgSlug: rehearsalOrg.slug,
				cookieHeader: personSessions.get(orgOwner.role)?.cookieHeader,
			})
			opened.push(orgSession)
			org = await snapshotOrg(orgSession, capture)
		} catch (error) {
			org = {
				slug: rehearsalOrg.slug,
				...(await captureOpenFailure(capture, 'org.session', error)),
			}
		}
		const carol = input.users.find((user) => user.role === 'carol')
		const alice = input.users.find((user) => user.role === 'alice')
		if (!carol || !alice) {
			throw new Error('Snapshot needs the alice and carol credentials.')
		}
		log('Snapshotting carol using alice credentials through her grants...')
		let grantee: JsonSnapshot['grantee']
		try {
			const aliceSession = personSessions.get('alice')
			if (!aliceSession) {
				throw new Error('Snapshot needs the alice person session.')
			}
			const carolInAlice = await openSession(input.origins.app, carol, {
				orgSlug: alice.orgSlug,
				cookieHeader: personSessions.get('carol')?.cookieHeader,
			})
			opened.push(carolInAlice)
			grantee = await snapshotCredentialGrantee(
				carolInAlice,
				aliceSession,
				carol,
				alice,
				input.origins,
				capture,
			)
		} catch (error) {
			grantee = await captureOpenFailure(capture, 'grantee.session', error)
		}
		const shared = findPackagesListedByMoreThanOneOwner({
			...Object.fromEntries(
				people.map((person) => [person.role, person.packages]),
			),
			[`@${rehearsalOrg.slug}`]: 'packages' in org ? org.packages : null,
		})
		if (shared.length > 0) {
			failures.push({
				check: 'packages.ownedByOneOrg',
				error: shared
					.map(({ id, owners }) => `${id} is listed by ${owners.join(', ')}`)
					.join('; '),
			})
		}
		return {
			version: 1,
			takenAt: (input.now ?? (() => new Date()))().toISOString(),
			origins: input.origins,
			admin: adminView,
			people,
			org,
			grantee,
			failures,
		}
	} finally {
		await Promise.allSettled(opened.map((session) => session.close()))
	}
}

export type SnapshotDifference = {
	path: string
	before: unknown
	after: unknown
}

/**
 * Structural diff of two snapshots (or any JSON values), ignoring `takenAt`
 * and every `observed` section.
 */
/**
 * When every element is an object with a unique string identity field, key the
 * array by that field so inserts do not shift later index diffs. Prefer
 * `role` (people / D1 databases), then `table` (D1 table counts), then `id`.
 */
function keyedArrayView(
	items: ReadonlyArray<unknown>,
): { keyed: Record<string, unknown>; pathStyle: 'dot' } | null {
	const identityKeys = ['role', 'table', 'id'] as const
	for (const identityKey of identityKeys) {
		if (
			!items.every(
				(item) =>
					item !== null &&
					typeof item === 'object' &&
					!Array.isArray(item) &&
					identityKey in item,
			)
		) {
			continue
		}
		// Null prototype so identity values like "__proto__" stay own keys.
		const keyed: Record<string, unknown> = Object.create(null)
		const seen = new Set<string>()
		let unique = true
		for (const item of items) {
			const value = String((item as Record<string, unknown>)[identityKey] ?? '')
			if (seen.has(value)) {
				unique = false
				break
			}
			seen.add(value)
			keyed[value] = item
		}
		if (unique) return { keyed, pathStyle: 'dot' }
	}
	return null
}

export function diffSnapshots(
	before: unknown,
	after: unknown,
	path = '',
): Array<SnapshotDifference> {
	if (path === '.takenAt') return []
	if (
		before &&
		after &&
		typeof before === 'object' &&
		typeof after === 'object' &&
		Array.isArray(before) === Array.isArray(after)
	) {
		if (Array.isArray(before) && Array.isArray(after)) {
			const beforeKeyed = keyedArrayView(before)
			const afterKeyed = keyedArrayView(after)
			if (beforeKeyed && afterKeyed) {
				const keys = new Set([
					...Object.keys(beforeKeyed.keyed),
					...Object.keys(afterKeyed.keyed),
				])
				return [...keys]
					.sort()
					.flatMap((key) =>
						diffSnapshots(
							beforeKeyed.keyed[key],
							afterKeyed.keyed[key],
							`${path}.${key}`,
						),
					)
			}
		}
		const keys = new Set([...Object.keys(before), ...Object.keys(after)])
		return [...keys].sort().flatMap((key) => {
			// Skip people/metrics `observed` object properties only — not a
			// keyed identity segment that happens to be named "observed".
			if (!Array.isArray(before) && key === 'observed') return []
			return diffSnapshots(
				(before as Record<string, unknown>)[key],
				(after as Record<string, unknown>)[key],
				Array.isArray(before) ? `${path}[${key}]` : `${path}.${key}`,
			)
		})
	}
	return JSON.stringify(before) === JSON.stringify(after)
		? []
		: [{ path, before, after }]
}
