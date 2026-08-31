import {
	readCurrentEntitlementResourceUsage,
	type EntitlementUsageEnv,
} from '#worker/entitlements/service.ts'
import { listIntegrations } from '#worker/integrations/service.ts'
import { listMcpServerSettings } from '#worker/mcp-client/settings-service.ts'
import {
	type OnboardingChecklistItem,
	type OnboardingChecklistItemId,
} from '#universal/onboarding-process.ts'

/**
 * Derived onboarding progress. Every item is computed from data the platform
 * already stores. Dismissal lives on `users.onboarding_checklist_dismissed_at`.
 */

export type { OnboardingChecklistItem, OnboardingChecklistItemId }

export type OnboardingChecklist = {
	items: Array<OnboardingChecklistItem>
	complete: boolean
}

export type OnboardingChecklistEnv = Pick<Env, 'APP_DB'> & EntitlementUsageEnv

/**
 * Compute the checklist from existing signals: MCP OAuth grants (passed in),
 * saved integrations or MCP servers, and the saved-package meter. Individual
 * probe failures fail open to "not done" so a storage blip never breaks
 * onboarding surfaces. The optional first-win email loop is not a checklist
 * item.
 */
export async function deriveOnboardingChecklist(input: {
	env: OnboardingChecklistEnv
	userId: string
	emailVerified: boolean
	hasMcpClient: boolean
	now?: Date
}): Promise<OnboardingChecklist> {
	const { env, userId } = input
	const now = input.now ?? new Date()
	const [integrations, mcpServers, savedPackages] = await Promise.all([
		listIntegrations({ env, userId }).catch(() => [] as Array<unknown>),
		listMcpServerSettings({ env, userId }).catch(() => [] as Array<unknown>),
		readCurrentEntitlementResourceUsage({
			db: env.APP_DB,
			env,
			userId,
			resource: 'saved_packages',
			now,
		}).catch(() => 0),
	])

	const items: Array<OnboardingChecklistItem> = [
		{ id: 'verify-email', done: input.emailVerified },
		{ id: 'connect-agent', done: input.hasMcpClient },
		{
			id: 'connect-integration',
			done: integrations.length > 0 || mcpServers.length > 0,
		},
		{ id: 'install-starter', done: savedPackages > 0 },
	]
	return {
		items,
		complete: items.every((item) => item.done),
	}
}

export async function readOnboardingChecklistDismissed(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
}): Promise<boolean> {
	try {
		const dismissedAt = await readDismissedAtColumn(
			input.env.APP_DB,
			input.userId,
		)
		return Boolean(dismissedAt)
	} catch {
		return false
	}
}

export async function dismissOnboardingChecklist(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
}): Promise<void> {
	await writeDismissedAtColumn(
		input.env.APP_DB,
		input.userId,
		new Date().toISOString(),
	)
}

async function readDismissedAtColumn(db: D1Database, userId: string) {
	const row = await db
		.prepare(
			`SELECT onboarding_checklist_dismissed_at
			 FROM users
			 WHERE stable_user_id = ?
			 LIMIT 1`,
		)
		.bind(userId)
		.first<{ onboarding_checklist_dismissed_at: string | null }>()
	const dismissedAt = row?.onboarding_checklist_dismissed_at?.trim()
	return dismissedAt ? dismissedAt : null
}

async function writeDismissedAtColumn(
	db: D1Database,
	userId: string,
	dismissedAt: string,
) {
	await db
		.prepare(
			`UPDATE users
			 SET onboarding_checklist_dismissed_at = ?,
			     updated_at = CURRENT_TIMESTAMP
			 WHERE stable_user_id = ?`,
		)
		.bind(dismissedAt, userId)
		.run()
}
