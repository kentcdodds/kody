import { utcMonthKey } from '@kody-internal/shared/date-keys.ts'
import {
	deriveOnboardingChecklist,
	readOnboardingChecklistDismissed,
} from '#mcp/onboarding-checklist.ts'
import { getCachedMcpClientHubSnapshot } from '#worker/mcp-client/hub-client.ts'
import { type McpClientHubSnapshot } from '#worker/mcp-client/types.ts'
import { listMcpServerSettings } from '#worker/mcp-client/settings-service.ts'
import { listSavedPackagesByUserId } from '#worker/package-registry/repo.ts'
import { readEntitlementUsageSnapshot } from '#worker/entitlements/usage-snapshot.ts'
import { getUserPlan } from '#worker/entitlements/service.ts'
import { isSavedPackageLocked } from '#worker/package-registry/package-publish-lock.ts'
import {
	buildWaitingItems,
	isUnexpiredEpochMs,
	isWaitingMcpServerState,
	type WaitingItem,
	type WaitingMcpServerSignal,
	type WaitingSignals,
} from '#universal/waiting.ts'

export type DeriveWaitingUser = {
	userId: number
	stableUserId: string
	email: string
	emailVerified: boolean
}

type WaitingEnv = Env & {
	OAUTH_PROVIDER?: {
		listUserGrants(
			userId: string,
			options?: { cursor?: string },
		): Promise<{ items: Array<unknown>; cursor?: string }>
	}
}

/**
 * Current-state waiting queue for one signed-in user. Every probe fails open
 * so a storage blip cannot hide the page or invent another user's items.
 */
export async function deriveWaitingItems(input: {
	env: WaitingEnv
	user: DeriveWaitingUser
	now?: Date
}): Promise<Array<WaitingItem>> {
	const signals = await collectWaitingSignals(input)
	return buildWaitingItems(signals)
}

export async function collectWaitingSignals(input: {
	env: WaitingEnv
	user: DeriveWaitingUser
	now?: Date
}): Promise<WaitingSignals> {
	const now = input.now ?? new Date()
	const { env, user } = input

	const [
		onboardingDismissed,
		hasMcpClient,
		mcpServers,
		lockedPackages,
		pendingEmailChange,
		errorRate,
		entitlementCaps,
	] = await Promise.all([
		readOnboardingChecklistDismissed({
			env,
			userId: user.stableUserId,
		}).catch(() => true),
		userHasMcpOAuthGrants(env, user.stableUserId),
		collectMcpServerSignals(env, user.stableUserId),
		collectLockedPackageSignals(env, user.stableUserId),
		collectPendingEmailChange(env, user.userId, now),
		collectErrorRate(env, user.stableUserId, now),
		collectEntitlementCaps(env, user, now),
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
		emailVerified: user.emailVerified,
		onboardingDismissed: onboardingDismissed || checklist.complete,
		onboardingRemaining: checklist.items
			.filter((item) => !item.done)
			.map((item) => item.id),
		mcpServers,
		lockedPackages,
		pendingEmailChange,
		errorRate,
		entitlementCaps,
	}
}

async function userHasMcpOAuthGrants(env: WaitingEnv, stableUserId: string) {
	const helpers = env.OAUTH_PROVIDER
	if (!helpers) return false
	try {
		const page = await helpers.listUserGrants(stableUserId)
		return page.items.length > 0
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

	let snapshot: McpClientHubSnapshot
	try {
		snapshot = await getCachedMcpClientHubSnapshot({
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

async function collectLockedPackageSignals(env: Env, userId: string) {
	const packages = await listSavedPackagesByUserId(env.APP_DB, {
		userId,
	}).catch(() => [] as Awaited<ReturnType<typeof listSavedPackagesByUserId>>)
	return packages
		.filter((pkg) => isSavedPackageLocked(pkg.lockedAt))
		.map((pkg) => ({
			id: pkg.id,
			name: pkg.name,
			kodyId: pkg.kodyId,
		}))
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
		const month = utcMonthKey(now)
		const row = await env.APP_DB.prepare(
			`SELECT SUM(event_count) AS event_count, SUM(error_count) AS error_count
			 FROM usage_rollups
			 WHERE user_id = ? AND month = ?`,
		)
			.bind(userId, month)
			.first<{ event_count: number | null; error_count: number | null }>()
		return {
			errorCount: Number(row?.error_count ?? 0),
			eventCount: Number(row?.event_count ?? 0),
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
		const plan = await getUserPlan(env.APP_DB, {
			userId: user.stableUserId,
			email: user.email,
		})
		const snapshot = await readEntitlementUsageSnapshot({
			db: env.APP_DB,
			env,
			usageUserId: user.stableUserId,
			plan,
			now,
		})
		return snapshot.resources
			.filter(
				(row) =>
					row.percentOfLimit != null &&
					row.percentOfLimit >= 1 &&
					row.limit > 0,
			)
			.map((row) => ({
				resource: row.resource,
				label: row.label,
			}))
	} catch {
		return []
	}
}
