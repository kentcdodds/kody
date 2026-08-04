import { expect, test, vi } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { isEntitlementLimitError } from '#worker/entitlements/errors.ts'
import { planLimits } from '#worker/entitlements/plans.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { createMcpCallerContext } from '#mcp/context.ts'

const mockModule = vi.hoisted(() => ({
	ensureEntitySource: vi.fn(),
}))

vi.mock('#worker/repo/source-service.ts', () => ({
	ensureEntitySource: (...args: Array<unknown>) =>
		mockModule.ensureEntitySource(...args),
}))

const { repoCreateCapability } = await import('./repo-create.ts')

function createDatabase(
	initialRows: {
		users?: Array<Record<string, unknown>>
		user_repos?: Array<Record<string, unknown>>
	} = {},
) {
	const tables = new Map<string, Array<Record<string, unknown>>>([
		['users', (initialRows.users ?? []).map((row) => ({ ...row }))],
		['user_repos', (initialRows.user_repos ?? []).map((row) => ({ ...row }))],
	])

	return {
		prepare(query: string) {
			return {
				bind(...params: Array<unknown>) {
					return {
						async first<T>() {
							if (query.includes('SELECT plan, stripe_plan FROM users')) {
								const email = params[0]
								const stableUserId = params[1]
								const user = tables
									.get('users')
									?.find(
										(row) =>
											row['email'] === email &&
											row['stable_user_id'] === stableUserId,
									)
								return (user ? { plan: user['plan'] } : null) as T | null
							}
							if (
								query.includes('FROM user_repos') &&
								query.includes('COUNT')
							) {
								const userId = params[0]
								const count = (tables.get('user_repos') ?? []).filter(
									(row) => row['user_id'] === userId,
								).length
								return { count } as T
							}
							if (
								query.includes('FROM user_repos') &&
								query.includes('user_id = ? AND name = ?')
							) {
								const userId = params[0]
								const name = params[1]
								const row = (tables.get('user_repos') ?? []).find(
									(row) => row['user_id'] === userId && row['name'] === name,
								)
								return (row ? { id: row['id'] } : null) as T | null
							}
							throw new Error(`Unsupported first query: ${query}`)
						},
						async run() {
							if (query.startsWith('INSERT INTO user_repos')) {
								const row = {
									id: params[0],
									user_id: params[1],
									name: params[2],
									description: params[3],
									created_at: params[4],
									updated_at: params[5],
								}
								const table = tables.get('user_repos') ?? []
								const duplicate = table.some(
									(existing) =>
										existing['user_id'] === row.user_id &&
										existing['name'] === row.name,
								)
								if (duplicate) {
									throw new Error('UNIQUE constraint failed: user_repos.name')
								}
								table.push(row)
								tables.set('user_repos', table)
								return { meta: { changes: 1 } }
							}
							throw new Error(`Unsupported run query: ${query}`)
						},
					}
				},
			}
		},
	} as unknown as D1Database
}

const userEmail = 'repo-create@test.invalid'
const stableUserId = createStableUserIdFromEmail(userEmail)

test('repo_create creates within entitlement, rejects duplicates, and gates side effects at the repos ceiling', async () => {
	mockModule.ensureEntitySource.mockResolvedValue({
		id: 'source-1',
		repo_id: 'repo-artifacts-1',
	})
	const db = createDatabase({
		users: [{ email: userEmail, plan: 'free', stable_user_id: stableUserId }],
	})
	const ctx = {
		env: { APP_DB: db } as Env,
		callerContext: createMcpCallerContext({
			user: { userId: stableUserId, email: userEmail },
			baseUrl: 'https://kody.test',
		}),
	}
	const result = await repoCreateCapability.handler(
		{ name: 'notes', description: 'scratch notes' },
		ctx,
	)
	expect(result.name).toBe('notes')
	expect(result.source_id).toBe('source-1')
	expect(mockModule.ensureEntitySource).toHaveBeenCalledWith(
		expect.objectContaining({
			entityKind: 'repo',
			userId: stableUserId,
		}),
	)

	await expect(
		repoCreateCapability.handler({ name: 'notes' }, ctx),
	).rejects.toThrow(McpCallerError)

	const limit = planLimits.free.maxRepos
	mockModule.ensureEntitySource.mockClear()
	const atCeiling = createDatabase({
		users: [{ email: userEmail, plan: 'free', stable_user_id: stableUserId }],
		user_repos: Array.from({ length: limit }, (_, index) => ({
			id: `repo-${index}`,
			user_id: stableUserId,
			name: `repo-${index}`,
			description: null,
		})),
	})
	const ceilingCtx = {
		env: { APP_DB: atCeiling } as Env,
		callerContext: createMcpCallerContext({
			user: { userId: stableUserId, email: userEmail },
			baseUrl: 'https://kody.test',
		}),
	}
	await expect(
		repoCreateCapability.handler({ name: 'another' }, ceilingCtx),
	).rejects.toSatisfy((error: unknown) => {
		expect(isEntitlementLimitError(error)).toBe(true)
		if (isEntitlementLimitError(error)) {
			expect(error.details.code).toBe('entitlement_limit_exceeded')
			expect(error.details.resource).toBe('repos')
		}
		return true
	})
	expect(mockModule.ensureEntitySource).not.toHaveBeenCalled()
})
