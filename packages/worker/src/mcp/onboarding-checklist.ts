import { countInternalUserEmailMessages } from '#worker/email/mailbox-internal-read.ts'
import {
	readCurrentEntitlementResourceUsage,
	type EntitlementUsageEnv,
} from '#worker/entitlements/service.ts'
import { listIntegrations } from '#worker/integrations/service.ts'
import { listMemoriesByUserId } from '#mcp/memory/repo.ts'
import { getValue, saveValue } from '#mcp/values/service.ts'
import {
	type OnboardingChecklistItem,
	type OnboardingChecklistItemId,
} from '#worker/onboarding-checklist-types.ts'

/**
 * Derived onboarding progress. Every item is computed from data the platform
 * already stores — the only persisted state is the dismissal, kept as a
 * user-scoped value so it survives across devices and agents.
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
 * Compute the checklist from existing signals: one Mailbox DO count (stored
 * INBOUND mail — the welcome email alone is outbound, so "exchange a first
 * email" only completes once the user's reply lands), and three cheap D1
 * reads (active memories, saved integrations, saved packages). Individual
 * probe failures fail open to "not done" so a storage blip never breaks
 * onboarding surfaces.
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
	const [inboundMail, memories, integrations, savedPackages] =
		await Promise.all([
			countInternalUserEmailMessages({
				env,
				ownerId: userId,
				filters: { direction: 'inbound' },
			}).catch(() => 0),
			listMemoriesByUserId(env.APP_DB, userId, {
				limit: 1,
				statuses: ['active'],
			}).catch(() => []),
			listIntegrations({ env, userId }).catch(() => [] as Array<unknown>),
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
		{ id: 'first-hello', done: inboundMail > 0 },
		{ id: 'save-memory', done: memories.length > 0 },
		{ id: 'connect-integration', done: integrations.length > 0 },
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
		const value = await getValue({
			env: input.env,
			userId: input.userId,
			storageContext: userScopedStorageContext,
			scope: 'user',
			name: onboardingChecklistDismissedValueName,
		})
		return value !== null
	} catch {
		return false
	}
}

export async function dismissOnboardingChecklist(input: {
	env: Pick<Env, 'APP_DB'> & Parameters<typeof saveValue>[0]['env']
	userId: string
}): Promise<void> {
	await saveValue({
		env: input.env,
		userId: input.userId,
		storageContext: userScopedStorageContext,
		scope: 'user',
		name: onboardingChecklistDismissedValueName,
		value: new Date().toISOString(),
		description:
			'Set when the onboarding checklist is dismissed; delete this value to bring the checklist back.',
	})
}
