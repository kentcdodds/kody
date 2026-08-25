import { countInternalUserEmailMessages } from '#worker/email/mailbox-internal-read.ts'
import {
	readCurrentEntitlementResourceUsage,
	type EntitlementUsageEnv,
} from '#worker/entitlements/service.ts'
import { listIntegrations } from '#worker/integrations/service.ts'
import { listMcpServerSettings } from '#worker/mcp-client/settings-service.ts'
import { listSavedPackagesByUserId } from '#worker/package-registry/repo.ts'
import { listMemoriesByUserId } from '#mcp/memory/repo.ts'
import { getValue } from '#mcp/values/service.ts'
import {
	type OnboardingChecklistItem,
	type OnboardingChecklistItemId,
} from '#universal/onboarding-checklist-types.ts'

/**
 * Derived onboarding progress. Every item is computed from data the platform
 * already stores. Dismissal lives on `users.onboarding_checklist_dismissed_at`.
 * Leftover `onboardingChecklistDismissed` values are copied on read until
 * migration 0015 deletes those rows.
 */

export type { OnboardingChecklistItem, OnboardingChecklistItemId }

export type OnboardingChecklist = {
	items: Array<OnboardingChecklistItem>
	complete: boolean
}

export const onboardingChecklistDismissedValueName =
	'onboardingChecklistDismissed'

/** User-scope value lookups bind with no session or app. */
const userScopedStorageContext = { sessionId: null, appId: null }

export type OnboardingChecklistEnv = Pick<Env, 'APP_DB'> &
	EntitlementUsageEnv & { MAILBOX: Env['MAILBOX'] }

/**
 * First-win Send sub-step: a successful `email_send` (UserMeter daily count)
 * or any stored outbound mailbox copy. Meter covers the case where Hotmail
 * already received the message but the mailbox mirror lagged; mailbox covers
 * sends from a previous UTC day after the daily meter resets. Failed mailbox
 * stores refund the meter before throwing, so a rejected send cannot mark
 * Send done. Probe failures fail open to false so a Mailbox or UserMeter
 * blip never marks Send done.
 */
export async function userHasSentWelcomeEmail(input: {
	env: OnboardingChecklistEnv
	userId: string
	now?: Date
}): Promise<boolean> {
	const now = input.now ?? new Date()
	const [outboundMail, emailSendsToday] = await Promise.all([
		countInternalUserEmailMessages({
			env: input.env,
			ownerId: input.userId,
			filters: { direction: 'outbound' },
		}).catch(() => 0),
		readCurrentEntitlementResourceUsage({
			db: input.env.APP_DB,
			env: input.env,
			userId: input.userId,
			resource: 'email_sends_per_day',
			now,
		}).catch(() => 0),
	])
	return outboundMail > 0 || emailSendsToday > 0
}

/**
 * Compute the checklist from existing signals: one Mailbox inbound count
 * (the welcome email alone is outbound, so "exchange a first email" only
 * completes once the user's reply lands), and cheap D1 reads (active
 * memories, saved integrations or MCP servers, saved packages). Individual
 * probe failures fail open to "not done" so a storage blip never breaks
 * onboarding surfaces.
 */
export function assembleOnboardingChecklist(input: {
	emailVerified: boolean
	hasMcpClient: boolean
	inboundMail: number
	hasMemory: boolean
	hasIntegrationOrMcp: boolean
	hasSavedPackage: boolean
}): OnboardingChecklist {
	const items: Array<OnboardingChecklistItem> = [
		{ id: 'verify-email', done: input.emailVerified },
		{ id: 'connect-agent', done: input.hasMcpClient },
		{ id: 'first-hello', done: input.inboundMail > 0 },
		{ id: 'save-memory', done: input.hasMemory },
		{ id: 'connect-integration', done: input.hasIntegrationOrMcp },
		{ id: 'install-starter', done: input.hasSavedPackage },
	]
	return {
		items,
		complete: items.every((item) => item.done),
	}
}

export async function deriveOnboardingChecklist(input: {
	env: OnboardingChecklistEnv
	userId: string
	emailVerified: boolean
	hasMcpClient: boolean
	/** Preloaded inbound count; skips a second Mailbox inbound probe. */
	inboundMail?: number
}): Promise<OnboardingChecklist> {
	const { env, userId } = input
	const [inboundMail, memories, integrations, mcpServers, savedPackages] =
		await Promise.all([
			input.inboundMail !== undefined
				? Promise.resolve(input.inboundMail)
				: countInternalUserEmailMessages({
						env,
						ownerId: userId,
						filters: { direction: 'inbound' },
					}).catch(() => 0),
			listMemoriesByUserId(env.APP_DB, userId, {
				limit: 1,
				statuses: ['active'],
			}).catch(() => []),
			listIntegrations({ env, userId }).catch(() => [] as Array<unknown>),
			listMcpServerSettings({ env, userId }).catch(() => [] as Array<unknown>),
			listSavedPackagesByUserId(env.APP_DB, { userId }).catch(
				() => [] as Array<unknown>,
			),
		])

	return assembleOnboardingChecklist({
		emailVerified: input.emailVerified,
		hasMcpClient: input.hasMcpClient,
		inboundMail,
		hasMemory: memories.length > 0,
		hasIntegrationOrMcp: integrations.length > 0 || mcpServers.length > 0,
		hasSavedPackage: savedPackages.length > 0,
	})
}

export async function readOnboardingChecklistDismissed(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
}): Promise<boolean> {
	try {
		const column = await readDismissedAtColumn(input.env.APP_DB, input.userId)
		if (column) return true

		const leftover = await getValue({
			env: input.env,
			userId: input.userId,
			storageContext: userScopedStorageContext,
			scope: 'user',
			name: onboardingChecklistDismissedValueName,
		})
		if (!leftover) return false

		const dismissedAt =
			leftover.value.trim() || leftover.updatedAt || new Date().toISOString()
		await writeDismissedAtColumn(input.env.APP_DB, input.userId, dismissedAt)
		return true
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
