import { expect, test, vi } from 'vitest'
import { utcDayKey } from '@kody-internal/shared/date-keys.ts'
import { planLimits } from '#universal/plans.ts'
import { consumeDailyEntitlement } from '#worker/entitlements/service.ts'
import { userMeterRpc } from '#worker/entitlements/user-meter-client.ts'
import { entitlementLimitErrorCode } from '#worker/entitlements/errors.ts'
import { invokePackageExport } from './service.ts'
import { clearInvokeContractCachesForTests } from './invoke-contract-cache.ts'
import {
	packageInvocationsRepoMockModule as repoMockModule,
	createDatabase,
	createEnvWithUserMeter,
	createToken,
	seedPackageResolution,
} from '#worker/test-support/package-invocations.ts'
import { automationInvocationsPerDayResource } from './automation-invocation-entitlement.ts'

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: (...args: Array<unknown>) =>
		repoMockModule.getSavedPackageById(...args),
	getSavedPackageByKodyId: (...args: Array<unknown>) =>
		repoMockModule.getSavedPackageByKodyId(...args),
	getSavedPackageByName: (...args: Array<unknown>) =>
		repoMockModule.getSavedPackageByName(...args),
	listSavedPackagesByUserId: (...args: Array<unknown>) =>
		repoMockModule.listSavedPackagesByUserId(...args),
}))

vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageManifestBySourceId: (...args: Array<unknown>) =>
		repoMockModule.loadPackageManifestBySourceId(...args),
	loadPackageSourceBySourceId: (...args: Array<unknown>) =>
		repoMockModule.loadPackageSourceBySourceId(...args),
	loadPackageSourceRowForUser: (...args: Array<unknown>) =>
		repoMockModule.loadPackageSourceRowForUser(...args),
	loadPackageManifestForSource: (...args: Array<unknown>) =>
		repoMockModule.loadPackageManifestForSource(...args),
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceById: (...args: Array<unknown>) =>
		repoMockModule.getEntitySourceById(...args),
}))

vi.mock('#worker/package-runtime/published-bundle-artifacts.ts', () => ({
	loadPublishedBundleArtifactByIdentity: (...args: Array<unknown>) =>
		repoMockModule.loadPublishedBundleArtifactByIdentity(...args),
	persistPublishedBundleArtifact: (...args: Array<unknown>) =>
		repoMockModule.persistPublishedBundleArtifact(...args),
}))

vi.mock('#worker/repo/checks.ts', () => ({
	typecheckPackageEntrypointsFromSourceFiles: (...args: Array<unknown>) =>
		repoMockModule.typecheckPackageEntrypointsFromSourceFiles(...args),
}))

vi.mock('#mcp/run-kody-registry.ts', () => ({
	runBundledModuleWithRegistry: (...args: Array<unknown>) =>
		repoMockModule.runBundledModuleWithRegistry(...args),
}))

vi.mock('#worker/usage/agent-package-conversation-uses.ts', () => ({
	recordAgentPackageConversationUse: (...args: Array<unknown>) =>
		repoMockModule.recordAgentPackageConversationUse(...args),
}))

vi.mock('#worker/run-records/package-subscriptions.ts', () => ({
	dispatchRunErrorSubscriptionEvents: (...args: Array<unknown>) =>
		repoMockModule.dispatchRunErrorSubscriptionEvents(...args),
}))

vi.mock('#worker/identity/background-mcp-user.ts', () => ({
	resolveBackgroundMcpUser: async (_db: D1Database, userId: string) => ({
		userId,
		email: 'owner@example.com',
		username: 'owner',
		displayName: 'Owner',
	}),
}))

function prepareSuccessfulExport() {
	clearInvokeContractCachesForTests()
	seedPackageResolution()
	repoMockModule.runBundledModuleWithRegistry.mockReset()
	repoMockModule.runBundledModuleWithRegistry.mockResolvedValue({
		result: { ok: true },
		logs: [],
	})
}

test('automation_invocations_per_day under quota succeeds without touching execute', async () => {
	prepareSuccessfulExport()
	const db = createDatabase()
	const { env } = createEnvWithUserMeter(db)
	const token = createToken()
	const day = utcDayKey()

	const response = await invokePackageExport({
		env,
		baseUrl: 'https://example.test',
		token,
		request: {
			packageIdOrKodyId: '@owner/pkg',
			exportName: './dispatch-message-created',
			params: { n: 1 },
			idempotencyKey: 'automation-under-quota',
			source: 'webhook',
		},
	})
	expect(response.status).toBe(200)
	expect(repoMockModule.runBundledModuleWithRegistry).toHaveBeenCalledTimes(1)

	const automation = await userMeterRpc({
		env,
		userId: token.userId,
	}).read({ resource: automationInvocationsPerDayResource, day })
	expect(automation).toMatchObject({ outcome: 'ready', count: 1 })

	const execute = await userMeterRpc({
		env,
		userId: token.userId,
	}).read({ resource: 'execute_calls_per_day', day })
	expect(execute.outcome === 'ready' ? execute.count : 0).toBe(0)
})

test('automation_invocations_per_day at quota fails before sandbox and leaves execute free', async () => {
	prepareSuccessfulExport()
	const db = createDatabase()
	const { env, meter } = createEnvWithUserMeter(db)
	const token = createToken()
	const day = utcDayKey()
	const limit = planLimits.free.maxAutomationInvocationsPerDay

	await meter.seed({
		userId: token.userId,
		resource: automationInvocationsPerDayResource,
		day,
		count: limit,
	})

	const denied = await invokePackageExport({
		env,
		baseUrl: 'https://example.test',
		token,
		request: {
			packageIdOrKodyId: '@owner/pkg',
			exportName: './dispatch-message-created',
			params: { n: 2 },
			idempotencyKey: 'automation-over-quota',
			source: 'webhook',
		},
	})
	expect(denied.status).toBe(429)
	expect(denied.body).toMatchObject({
		ok: false,
		error: {
			code: entitlementLimitErrorCode,
			details: {
				code: entitlementLimitErrorCode,
				resource: automationInvocationsPerDayResource,
				plan: 'free',
				limit,
				current: limit,
			},
		},
	})
	expect(repoMockModule.runBundledModuleWithRegistry).not.toHaveBeenCalled()

	await consumeDailyEntitlement({
		db: env.APP_DB,
		env,
		userId: token.userId,
		email: 'owner@example.com',
		resource: 'execute_calls_per_day',
	})
	const execute = await userMeterRpc({
		env,
		userId: token.userId,
	}).read({ resource: 'execute_calls_per_day', day })
	expect(execute).toMatchObject({ outcome: 'ready', count: 1 })

	const automation = await userMeterRpc({
		env,
		userId: token.userId,
	}).read({ resource: automationInvocationsPerDayResource, day })
	expect(automation).toMatchObject({ outcome: 'ready', count: limit })
})

test('execute_calls_per_day flood does not burn automation_invocations_per_day', async () => {
	clearInvokeContractCachesForTests()
	const db = createDatabase()
	const { env } = createEnvWithUserMeter(db)
	const userId = 'user-123'
	const day = utcDayKey()

	for (let i = 0; i < 3; i++) {
		await consumeDailyEntitlement({
			db: env.APP_DB,
			env,
			userId,
			email: 'owner@example.com',
			resource: 'execute_calls_per_day',
		})
	}

	const executeCount = await userMeterRpc({ env, userId }).read({
		resource: 'execute_calls_per_day',
		day,
	})
	expect(executeCount).toMatchObject({ outcome: 'ready', count: 3 })

	const automationCount = await userMeterRpc({ env, userId }).read({
		resource: automationInvocationsPerDayResource,
		day,
	})
	expect(automationCount.outcome === 'ready' ? automationCount.count : 0).toBe(
		0,
	)
})
