import { buildPackageAppUrl } from '@kody-internal/shared/public-urls.ts'
import { openRehearsalSession, type RehearsalSession } from './kody-session.ts'
import { type RehearsalOrigins, type RehearsalUser } from './rehearsal-env.ts'
import {
	appMarker,
	memoryQueries,
	personalPackageLeaf,
} from './rehearsal-packages.ts'
import {
	callCapability,
	integrationProofModule,
	packageExportModule,
	userSecretProofModule,
} from './seed.ts'

export type SnapshotUser = {
	role: RehearsalUser['role']
	email: string
	username: string
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

async function capture(fn: () => Promise<unknown>) {
	try {
		return stripVolatile(await fn())
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) }
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
) {
	const echoUrl = `${origins.mockCloudflare}/__mocks/rehearsal/echo`
	const packageName = `@${user.username}/${personalPackageLeaf}`
	const appUrl = buildPackageAppUrl({
		origin: origins.app,
		username: user.username,
		kodyId: personalPackageLeaf,
	})
	const memorySearches: Record<string, unknown> = {}
	for (const query of memoryQueries) {
		memorySearches[query] = await capture(async () =>
			memoryMatchesSummary(
				await callCapability(session, 'metaMemorySearch', { query, limit: 3 }),
			),
		)
	}
	return {
		role: user.role,
		me: await capture(() => callCapability(session, 'metaGetCurrentUser')),
		packages: await capture(() => callCapability(session, 'packageList')),
		appUrl,
		app: await capture(async () => {
			const response = await session.request(new URL(appUrl).pathname)
			return {
				status: response.status,
				servesApp:
					typeof response.body === 'string' &&
					response.body.includes(appMarker),
			}
		}),
		jobs: await capture(async () => {
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
		webhooks: await capture(() => callCapability(session, 'webhookList')),
		secrets: await capture(() => callCapability(session, 'secretList')),
		secretProofs: {
			user: await capture(() =>
				session.execute(userSecretProofModule(echoUrl)),
			),
			package: await capture(() =>
				session.execute(
					packageExportModule(`kody:${packageName}/secret-proof`),
				),
			),
		},
		integrations: await capture(() =>
			callCapability(session, 'integrationList'),
		),
		integrationProof: await capture(() =>
			session.execute(integrationProofModule(echoUrl)),
		),
		memorySearches,
		shares: {
			inbound: await capture(() =>
				callCapability(session, 'packageShareList', { scope: 'inbound' }),
			),
			outbound: await capture(() =>
				callCapability(session, 'packageShareList', { scope: 'outbound' }),
			),
		},
		tokens: await capture(async () => {
			const listed = (await session.api('tokenList')) as {
				tokens?: Array<Record<string, unknown>>
			}
			return (listed?.tokens ?? []).map((token) => ({
				id: token.id,
				name: token.name,
				scopes: token.scopes,
			}))
		}),
		usage: await capture(() => callCapability(session, 'usageGet')),
	}
}

export type JsonSnapshot = {
	version: 1
	takenAt: string
	origins: RehearsalOrigins
	admin: Record<string, unknown>
	people: Array<Awaited<ReturnType<typeof snapshotPerson>>>
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
}): Promise<JsonSnapshot> {
	const log = input.log ?? (() => {})
	const adminUser = input.users.find((user) => user.role === 'admin')
	if (!adminUser)
		throw new Error('Snapshot needs the rehearsal admin credentials.')
	const admin = await openRehearsalSession(input.origins.app, adminUser)
	const adminView: Record<string, unknown> = {}
	try {
		for (const user of input.users) {
			adminView[user.role] = {
				user: await capture(() =>
					callCapability(admin, 'adminUserGet', { email: user.email }),
				),
				wallet: await capture(() =>
					callCapability(admin, 'adminCreditWalletGet', { email: user.email }),
				),
			}
		}
		adminView.scopeGrants = await capture(() =>
			callCapability(admin, 'adminPackageScopeGrantList'),
		)
	} finally {
		await admin.close()
	}
	const people: JsonSnapshot['people'] = []
	for (const user of input.users.filter((entry) => entry.role !== 'admin')) {
		log(`Snapshotting ${user.role}...`)
		const session = await openRehearsalSession(input.origins.app, user)
		try {
			people.push(await snapshotPerson(session, user, input.origins))
		} finally {
			await session.close()
		}
	}
	return {
		version: 1,
		takenAt: (input.now ?? (() => new Date()))().toISOString(),
		origins: input.origins,
		admin: adminView,
		people,
	}
}

export type SnapshotDifference = {
	path: string
	before: unknown
	after: unknown
}

/** Structural diff of two snapshots (or any JSON values), ignoring `takenAt`. */
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
		const keys = new Set([...Object.keys(before), ...Object.keys(after)])
		return [...keys]
			.sort()
			.flatMap((key) =>
				diffSnapshots(
					(before as Record<string, unknown>)[key],
					(after as Record<string, unknown>)[key],
					Array.isArray(before) ? `${path}[${key}]` : `${path}.${key}`,
				),
			)
	}
	return JSON.stringify(before) === JSON.stringify(after)
		? []
		: [{ path, before, after }]
}
