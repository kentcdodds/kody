import { listIntegrations } from '#worker/integrations/service.ts'
import { listMcpServerSettings } from '#worker/mcp-client/settings-service.ts'
import { listSecrets } from '#mcp/secrets/service.ts'
import { listOwnerEmailMessages } from '#worker/email/owner-email-reader.ts'
import { jobsData } from '#worker/jobs/jobs-data.ts'
import { userHasFirstExecute } from '#worker/identity/activation-stamps.ts'
import { type OnboardingSessionMilestoneState } from '#universal/onboarding-process.ts'

async function userHasOwnerEmailInDirection(
	env: Env,
	userId: string,
	direction: 'inbound' | 'outbound',
) {
	try {
		const messages = await listOwnerEmailMessages({
			env,
			ownerId: userId,
			direction,
			limit: 1,
		})
		return messages.length > 0
	} catch {
		return false
	}
}

/**
 * Live first-session milestones from existing account activity. Fails open
 * so a D1 / mailbox / jobs blip never breaks the onboarding payload or the
 * search leftover-steps notice.
 */
export async function loadOnboardingMilestones(
	env: Env,
	userId: string,
): Promise<OnboardingSessionMilestoneState> {
	const [
		execute,
		secrets,
		mcpServers,
		integrations,
		emailSend,
		emailReceive,
		job,
	] = await Promise.all([
		userHasFirstExecute(env.APP_DB, userId),
		listSecrets({ env, userId })
			.then((rows) => rows.length > 0)
			.catch(() => false),
		listMcpServerSettings({ env, userId })
			.then((rows) => rows.length > 0)
			.catch(() => false),
		listIntegrations({ env, userId })
			.then((rows) => rows.length > 0)
			.catch(() => false),
		userHasOwnerEmailInDirection(env, userId, 'outbound'),
		userHasOwnerEmailInDirection(env, userId, 'inbound'),
		jobsData(env)
			.listJobsForUser({ userId })
			.then((rows) => rows.length > 0)
			.catch(() => false),
	])
	return {
		execute,
		access: mcpServers || integrations,
		secret: secrets,
		'email-send': emailSend,
		'email-receive': emailReceive,
		job,
	}
}
