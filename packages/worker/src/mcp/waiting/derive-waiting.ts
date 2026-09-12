import {
	deriveOnboardingChecklist,
	readOnboardingChecklistDismissed,
} from '#mcp/onboarding-checklist.ts'
import { listMemoriesByUserId } from '#mcp/memory/repo.ts'
import { listSecrets } from '#mcp/secrets/service.ts'
import { getCachedMcpClientHubServers } from '#worker/mcp-client/hub-client.ts'
import { type McpClientHubSnapshot } from '#worker/mcp-client/types.ts'
import { listMcpServerSettings } from '#worker/mcp-client/settings-service.ts'
import { loadInboundMcpConnectionState } from '#worker/connected-mcp-agents.ts'
import { resolveOAuthHelpers } from '#worker/oauth-helpers.ts'
import { type OAuthGrantListHelpers } from '#worker/oauth-grants.ts'
import { listSavedPackagesByUserId } from '#worker/package-registry/repo.ts'
import { readEntitlementUsageSnapshot } from '#worker/entitlements/usage-snapshot.ts'
import { getUserEntitlement } from '#worker/entitlements/service.ts'
import { isSavedPackageLocked } from '#worker/package-registry/package-publish-lock.ts'
import { listJoinedIntegrations } from '#worker/integrations/service.ts'
import { jobsData } from '#worker/jobs/jobs-data.ts'
import { readOfficialDiscordMembershipForUser } from '#worker/discord/guild-role.ts'
import { summarizeRunRecords } from '#worker/run-records/service.ts'
import { accountActivitySummaryWindowMs } from '#universal/account-activity-filters.ts'
import {
	buildWaitingItems,
	isUnexpiredEpochMs,
	isWaitingMcpServerState,
	waitingFirstUseIds,
	type WaitingExpiredSecretSignal,
	type WaitingFirstUseId,
	type WaitingIntegrationAuthSignal,
	type WaitingItem,
	type WaitingMcpServerSignal,
	type WaitingSignals,
} from '#universal/waiting.ts'

export type DeriveWaitingUser = {
	userId: number
	stableUserId: string
	email: string
	username: string
	emailVerified: boolean
}

type WaitingEnv = Env & {
	OAUTH_PROVIDER?: OAuthGrantListHelpers
}

/**
 * Current-state waiting queue for one signed-in user. Every probe fails open
 * so a storage blip cannot hide the page or invent another user's items.
 */
export async function deriveWaitingItems(input: {
	env: WaitingEnv
	user: DeriveWaitingUser
	now?: Date
	fetchImpl?: typeof fetch
}): Promise<Array<WaitingItem>> {
	const signals = await collectWaitingSignals(input)
	return buildWaitingItems(signals)
}

/**
 * Same queue as `deriveWaitingItems`, looked up by MCP `stable_user_id`.
 * Fail-open: missing user or a probe blip returns no items.
 */
export async function deriveWaitingItemsForStableUser(input: {
	env: WaitingEnv
	stableUserId: string
	email: string
	now?: Date
}): Promise<Array<WaitingItem>> {
	try {
		const userRow = await input.env.APP_DB.prepare(
			`SELECT id, username, email_verified_at FROM users WHERE stable_user_id = ? LIMIT 1`,
		)
			.bind(input.stableUserId)
			.first<{
				id: number
				username: string
				email_verified_at: string | null
			}>()
		if (!userRow) return []
		return await deriveWaitingItems({
			env: input.env,
			user: {
				userId: userRow.id,
				stableUserId: input.stableUserId,
				email: input.email,
				username: userRow.username,
				emailVerified: Boolean(userRow.email_verified_at),
			},
			now: input.now,
		})
	} catch {
		return []
	}
}

export async function collectWaitingSignals(input: {
	env: WaitingEnv
	user: DeriveWaitingUser
	now?: Date
	fetchImpl?: typeof fetch
}): Promise<WaitingSignals> {
	const now = input.now ?? new Date()
	const { env, user } = input

	const [
		onboardingDismissed,
		hasMcpClient,
		mcpServers,
		integrationsProbe,
		secretsProbe,
		packagesProbe,
		pendingEmailChange,
		errorRate,
		entitlementCaps,
		firstSearch,
		firstExecute,
		firstPackageStamp,
		firstMemory,
		firstJob,
		discordJoined,
	] = await Promise.all([
		readOnboardingChecklistDismissed({
			env,
			userId: user.stableUserId,
		}).catch(() => true),
		userHasMcpOAuthGrants(env, user.stableUserId),
		collectMcpServerSignals(env, user.stableUserId),
		probe(() => listJoinedIntegrations({ env, userId: user.stableUserId })),
		probe(() =>
			listSecrets({
				env,
				userId: user.stableUserId,
				scope: 'user',
			}),
		),
		probe(() =>
			listSavedPackagesByUserId(env.APP_DB, {
				userId: user.stableUserId,
			}),
		),
		collectPendingEmailChange(env, user.userId, now),
		collectErrorRate(env, user.stableUserId, now),
		collectEntitlementCaps(env, user, now),
		probeActivationStamp(env.APP_DB, user.stableUserId, 'search'),
		probeActivationStamp(env.APP_DB, user.stableUserId, 'execute'),
		probeActivationStamp(env.APP_DB, user.stableUserId, 'package'),
		probeHasMemory(env.APP_DB, user.stableUserId),
		probeHasJob(env, user.stableUserId),
		readOfficialDiscordMembershipForUser({
			env,
			userId: user.userId,
			fetchImpl: input.fetchImpl,
		}),
	])

	const checklist = await deriveOnboardingChecklist({
		env,
		userId: user.stableUserId,
		emailVerified: user.emailVerified,
		hasMcpClient,
		now,
	}).catch(() => ({
		items: [],
		complete: true,
	}))

	return {
		username: user.username,
		emailVerified: user.emailVerified,
		onboardingDismissed: onboardingDismissed || checklist.complete,
		onboardingRemaining: checklist.items
			.filter((item) => !item.done)
			.map((item) => item.id),
		mcpServers,
		integrationAuth: integrationsProbe.ok
			? reconnectableIntegrationAuth(integrationsProbe.value)
			: [],
		expiredSecrets: secretsProbe.ok
			? expiredUserSecrets(secretsProbe.value)
			: [],
		lockedPackages: packagesProbe.ok
			? lockedSavedPackages(packagesProbe.value)
			: [],
		pendingEmailChange,
		errorRate,
		entitlementCaps,
		firstUseMissing: collectFirstUseMissing({
			search: firstSearch,
			memory: firstMemory,
			execute: firstExecute,
			package: combineFirstPackage(firstPackageStamp, packagesProbe),
			job: firstJob,
			integration: integrationsProbe.ok
				? integrationsProbe.value.length > 0
				: null,
			secret: secretsProbe.ok ? secretsProbe.value.length > 0 : null,
			discord: discordJoined,
		}),
	}
}

type Probe<T> = { ok: true; value: T } | { ok: false }

async function probe<T>(fn: () => Promise<T>): Promise<Probe<T>> {
	try {
		return { ok: true, value: await fn() }
	} catch {
		return { ok: false }
	}
}

function collectFirstUseMissing(
	signals: Record<WaitingFirstUseId, boolean | null>,
): Array<WaitingFirstUseId> {
	return waitingFirstUseIds.filter((id) => signals[id] === false)
}

function combineFirstPackage(
	stamp: boolean | null,
	packagesProbe: Probe<Array<{ lockedAt: string | null }>>,
): boolean | null {
	const hasSavedPackage = packagesProbe.ok && packagesProbe.value.length > 0
	if (stamp === true || hasSavedPackage) return true
	if (stamp === false && packagesProbe.ok && packagesProbe.value.length === 0) {
		return false
	}
	return null
}

/**
 * `OAUTH_PROVIDER` is injected only inside the provider's `fetch` wrapper on
 * origin. The `waitingSummary` capability and search-tool waiting hints also
 * run in the sessionful `MCP` Durable Object on kody-platform, where
 * `resolveOAuthHelpers` builds the same helpers through the library.
 */
async function userHasMcpOAuthGrants(env: WaitingEnv, stableUserId: string) {
	try {
		const helpers = await resolveOAuthHelpers<OAuthGrantListHelpers>(env)
		if (!helpers) return false
		const inbound = await loadInboundMcpConnectionState(helpers, stableUserId)
		return inbound.uniqueClientCount > 0
	} catch {
		return false
	}
}

async function collectMcpServerSignals(
	env: Env,
	userId: string,
): Promise<Array<WaitingMcpServerSignal>> {
	const settings = await listMcpServerSettings({ env, userId }).catch(
		() => [] as Awaited<ReturnType<typeof listMcpServerSettings>>,
	)
	const enabled = settings.filter((server) => server.enabled)
	if (enabled.length === 0) return []

	let snapshot: Pick<McpClientHubSnapshot, 'servers'>
	try {
		snapshot = await getCachedMcpClientHubServers({
			env,
			userId,
		})
	} catch {
		// A hub blip must not invent reconnect cards for every enabled server.
		return []
	}
	const byId = new Map(
		snapshot.servers.map((server) => [server.serverId, server]),
	)

	const items: Array<WaitingMcpServerSignal> = []
	for (const server of enabled) {
		const live = byId.get(server.id)
		if (!live || !isWaitingMcpServerState(live.state)) continue
		items.push({
			id: server.id,
			name: server.name,
			state: live.state,
			error: live.error ?? null,
		})
	}
	return items
}

function reconnectableIntegrationAuth(
	rows: Awaited<ReturnType<typeof listJoinedIntegrations>>,
): Array<WaitingIntegrationAuthSignal> {
	const items: Array<WaitingIntegrationAuthSignal> = []
	for (const joined of rows) {
		const failure = joined.connection.lastAuthFailure
		if (!failure?.reconnectable) continue
		items.push({
			name: joined.connection.name,
			accountLabel: joined.connection.accountLabel,
			lane: joined.lane,
			reason: failure.reason,
		})
	}
	return items
}

function expiredUserSecrets(
	secrets: Awaited<ReturnType<typeof listSecrets>>,
): Array<WaitingExpiredSecretSignal> {
	return secrets
		.filter((secret) => secret.ttlMs != null && secret.ttlMs <= 0)
		.map((secret) => ({ name: secret.name }))
}

function lockedSavedPackages(
	packages: Awaited<ReturnType<typeof listSavedPackagesByUserId>>,
) {
	return packages
		.filter((pkg) => isSavedPackageLocked(pkg.lockedAt))
		.map((pkg) => ({
			id: pkg.id,
			name: pkg.name,
			kodyId: pkg.kodyId,
		}))
}

type ActivationStamp = 'search' | 'execute' | 'package'

function activationStampColumn(stamp: ActivationStamp) {
	switch (stamp) {
		case 'search':
			return 'first_search_at'
		case 'execute':
			return 'first_execute_at'
		case 'package':
			return 'first_saved_package_at'
		default: {
			const exhaustive: never = stamp
			throw new Error(`Unknown activation stamp: ${String(exhaustive)}`)
		}
	}
}

async function probeActivationStamp(
	db: D1Database,
	userId: string,
	stamp: ActivationStamp,
): Promise<boolean | null> {
	const column = activationStampColumn(stamp)
	try {
		const row = await db
			.prepare(
				`SELECT ${column}
				 FROM users
				 WHERE stable_user_id = ?
				 LIMIT 1`,
			)
			.bind(userId)
			.first<Record<string, string | null>>()
		if (!row) return null
		return Boolean(row[column])
	} catch {
		return null
	}
}

async function probeHasMemory(db: D1Database, userId: string) {
	try {
		const rows = await listMemoriesByUserId(db, userId, { limit: 1 })
		return rows.length > 0
	} catch {
		return null
	}
}

async function probeHasJob(env: WaitingEnv, userId: string) {
	try {
		const count = await jobsData(env).countJobsForUser({ userId })
		return count > 0
	} catch {
		return null
	}
}

async function collectPendingEmailChange(env: Env, userId: number, now: Date) {
	try {
		const row = await env.APP_DB.prepare(
			`SELECT new_email, expires_at
			 FROM pending_email_changes
			 WHERE user_id = ?
			 ORDER BY expires_at DESC
			 LIMIT 1`,
		)
			.bind(userId)
			.first<{ new_email: string; expires_at: number }>()
		if (!row || !isUnexpiredEpochMs(Number(row.expires_at), now)) {
			return null
		}
		const email = row.new_email?.trim()
		return email ? email : null
	} catch {
		return null
	}
}

async function collectErrorRate(env: Env, userId: string, now: Date) {
	try {
		// Count open (untriaged) Activity errors in the same 7-day window as
		// `/account/activity`. Monthly usage_rollups never drop when the user
		// ignores or resolves a run, so they cannot be the Waiting gate.
		const summary = await summarizeRunRecords({
			env,
			userId,
			since: new Date(
				now.getTime() - accountActivitySummaryWindowMs,
			).toISOString(),
		})
		return {
			errorCount: summary.errors,
			eventCount: summary.total,
		}
	} catch {
		return null
	}
}

async function collectEntitlementCaps(
	env: Env,
	user: DeriveWaitingUser,
	now: Date,
) {
	try {
		const entitlement = await getUserEntitlement(env.APP_DB, {
			userId: user.stableUserId,
			email: user.email,
		})
		const snapshot = await readEntitlementUsageSnapshot({
			db: env.APP_DB,
			env,
			usageUserId: user.stableUserId,
			plan: entitlement.plan,
			ladder: entitlement.ladder,
			now,
		})
		return snapshot.resources
			.filter(
				(row) =>
					(row.percentOfLimit != null &&
						row.percentOfLimit >= 1 &&
						row.limit > 0) ||
					(row.week != null &&
						row.week.percentOfLimit != null &&
						row.week.percentOfLimit >= 1 &&
						row.week.limit > 0),
			)
			.map((row) => ({
				resource: row.resource,
				label: row.label,
			}))
	} catch {
		return []
	}
}
