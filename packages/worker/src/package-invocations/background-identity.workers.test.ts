import { env } from 'cloudflare:workers'
import { expect, test, vi } from 'vitest'
import { metaGetCurrentUserCapability } from '#mcp/capabilities/meta/meta-get-current-user.ts'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { ensureUsersTestSchema } from '#worker/users-test-schema.ts'
import { runSavedPackageModuleOnce } from './module-execution.ts'

const mocks = vi.hoisted(() => ({
	ensureModuleArtifact: vi.fn(),
	runBundledModuleWithRegistry: vi.fn(),
}))

vi.mock('./module-artifacts.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('./module-artifacts.ts')>()),
	ensureModuleArtifact: mocks.ensureModuleArtifact,
}))

vi.mock('#mcp/run-kody-registry.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#mcp/run-kody-registry.ts')>()),
	runBundledModuleWithRegistry: mocks.runBundledModuleWithRegistry,
}))

test('subscription execution exposes the owner account identity to meta_get_current_user', async () => {
	const userId = 'a'.repeat(64)
	const email = 'subscription-owner@example.com'
	const displayName = 'Subscription Owner'
	await ensureUsersTestSchema({ db: env.APP_DB })
	await env.APP_DB.prepare(
		`INSERT INTO users (
			username,
			email,
			display_name,
			password_hash,
			stable_user_id
		) VALUES (?, ?, ?, ?, ?)`,
	)
		.bind(
			'subscription-owner',
			email,
			displayName,
			'test-password-hash',
			userId,
		)
		.run()

	mocks.ensureModuleArtifact.mockResolvedValue({
		artifact: {
			version: 1,
			kind: 'module',
			artifactName: 'subscription:email.message.received',
			sourceId: 'source-1',
			publishedCommit: 'commit-1',
			entryPoint: 'src/email-message-received.ts',
			mainModule: 'dist/subscription.js',
			modules: {
				'dist/subscription.js':
					'export default async function main() { return null }',
			},
			dependencies: [],
			packageContext: {
				packageId: 'package-1',
				kodyId: 'article-to-audio',
				sourceId: 'source-1',
			},
			serviceContext: null,
			createdAt: '2026-08-08T00:00:00.000Z',
		},
		source: {
			id: 'source-1',
			user_id: userId,
			entity_kind: 'package',
			entity_id: 'package-1',
			repo_id: 'repo-1',
			published_commit: 'commit-1',
			indexed_commit: null,
			manifest_path: 'package.json',
			source_root: '/',
			created_at: '2026-08-08T00:00:00.000Z',
			updated_at: '2026-08-08T00:00:00.000Z',
		},
	})
	mocks.runBundledModuleWithRegistry.mockImplementation(
		async (_env: Env, callerContext: McpCallerContext) => ({
			result: await metaGetCurrentUserCapability.handler(
				{},
				{ env, callerContext },
			),
			logs: [],
		}),
	)

	const outcome = await runSavedPackageModuleOnce({
		env,
		baseUrl: 'https://kody.dev',
		actor: {
			tokenId: 'internal:email-subscriptions',
			userId,
		},
		savedPackage: {
			id: 'package-1',
			userId,
			name: '@example/article-to-audio',
			kodyId: 'article-to-audio',
			description: 'Article to audio',
			tags: [],
			searchText: null,
			sourceId: 'source-1',
			hasApp: false,
			hidden: false,
			isPrivate: true,
			createdAt: '2026-08-08T00:00:00.000Z',
			updatedAt: '2026-08-08T00:00:00.000Z',
		},
		invocationName: 'subscription:email.message.received',
		moduleSelector: {
			kind: 'subscription',
			topic: 'email.message.received',
		},
		params: { event: 'email.message.received' },
		idempotencyKey: null,
		invocationId: null,
		source: 'email',
		topic: 'email.message.received',
		notFoundCode: 'subscription_not_found',
		toolFactories: {
			createPackageRuntimeInvokeTools: vi.fn(() => ({}) as never),
			createPackageEventTools: vi.fn(() => ({}) as never),
		},
	})

	expect(outcome).toMatchObject({
		kind: 'completed',
		response: {
			status: 200,
			body: {
				result: {
					user_id: userId,
					email,
					display_name: displayName,
				},
			},
		},
	})
})
