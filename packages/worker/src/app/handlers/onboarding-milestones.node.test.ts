import { expect, test, vi } from 'vitest'
import { loadOnboardingMilestones } from '#mcp/onboarding-milestones.ts'
import { emptyOnboardingSessionMilestones } from '#universal/onboarding-process.ts'

const mockModule = vi.hoisted(() => ({
	userHasFirstExecute: vi.fn(),
	listSecrets: vi.fn(),
	listMcpServerSettings: vi.fn(),
	listIntegrations: vi.fn(),
	listOwnerEmailMessages: vi.fn(),
	listJobsForUser: vi.fn(),
}))

vi.mock('#worker/identity/activation-stamps.ts', () => ({
	userHasFirstExecute: (...args: Array<unknown>) =>
		mockModule.userHasFirstExecute(...args),
}))

vi.mock('#mcp/secrets/service.ts', () => ({
	listSecrets: (...args: Array<unknown>) => mockModule.listSecrets(...args),
}))

vi.mock('#worker/mcp-client/settings-service.ts', () => ({
	listMcpServerSettings: (...args: Array<unknown>) =>
		mockModule.listMcpServerSettings(...args),
}))

vi.mock('#worker/integrations/service.ts', () => ({
	listIntegrations: (...args: Array<unknown>) =>
		mockModule.listIntegrations(...args),
}))

vi.mock('#worker/email/owner-email-reader.ts', () => ({
	listOwnerEmailMessages: (...args: Array<unknown>) =>
		mockModule.listOwnerEmailMessages(...args),
}))

vi.mock('#worker/jobs/jobs-data.ts', () => ({
	jobsData: () => ({
		listJobsForUser: (...args: Array<unknown>) =>
			mockModule.listJobsForUser(...args),
	}),
}))

test('onboarding milestones read execute, access, secret, email, and jobs', async () => {
	mockModule.userHasFirstExecute.mockResolvedValue(true)
	mockModule.listSecrets.mockResolvedValue([{ id: 'sec-1' }])
	mockModule.listMcpServerSettings.mockResolvedValue([])
	mockModule.listIntegrations.mockResolvedValue([{ id: 'int-1' }])
	mockModule.listOwnerEmailMessages.mockImplementation(
		async (input: { direction?: 'inbound' | 'outbound' }) => {
			if (input.direction === 'outbound') return [{ id: 'out-1' }]
			return []
		},
	)
	mockModule.listJobsForUser.mockResolvedValue([{ id: 'job-1' }])

	await expect(loadOnboardingMilestones({} as Env, 'user-1')).resolves.toEqual({
		execute: true,
		access: true,
		secret: true,
		'email-send': true,
		'email-receive': false,
		job: true,
	})
	expect(mockModule.listOwnerEmailMessages).toHaveBeenCalledWith(
		expect.objectContaining({
			ownerId: 'user-1',
			direction: 'outbound',
			limit: 1,
		}),
	)
	expect(mockModule.listOwnerEmailMessages).toHaveBeenCalledWith(
		expect.objectContaining({
			ownerId: 'user-1',
			direction: 'inbound',
			limit: 1,
		}),
	)
})

test('onboarding milestones fail open when mailbox or jobs probes throw', async () => {
	mockModule.userHasFirstExecute.mockResolvedValue(false)
	mockModule.listSecrets.mockRejectedValue(new Error('secrets down'))
	mockModule.listMcpServerSettings.mockRejectedValue(new Error('mcp down'))
	mockModule.listIntegrations.mockRejectedValue(new Error('integrations down'))
	mockModule.listOwnerEmailMessages.mockRejectedValue(new Error('mailbox down'))
	mockModule.listJobsForUser.mockRejectedValue(new Error('jobs down'))

	await expect(loadOnboardingMilestones({} as Env, 'user-1')).resolves.toEqual(
		emptyOnboardingSessionMilestones,
	)
})
