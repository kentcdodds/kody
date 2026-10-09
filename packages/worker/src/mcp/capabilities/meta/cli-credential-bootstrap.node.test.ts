import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { cliCredentialBootstrapCapability } from './cli-credential-bootstrap.ts'

test.each([
	['saved-package', { packageId: 'package-1' }],
	['app', { appId: 'app-1' }],
])(
	'cliCredentialBootstrap rejects %s runtime contexts',
	async (_runtime, storageContext) => {
		await expect(
			cliCredentialBootstrapCapability.handler(
				{},
				{
					env: {} as Env,
					callerContext: createMcpCallerContext({
						source: { kind: 'mcp-oauth' },
						baseUrl: 'https://kody.codes',
						user: {
							userId: personIdFromStored('user-1'),
							email: 'user@example.com',
							displayName: 'User',
						},
						storageContext: {
							sessionId: null,
							appId: 'appId' in storageContext ? storageContext.appId : null,
							packageId:
								'packageId' in storageContext ? storageContext.packageId : null,
							storageId: null,
						},
					}),
				},
			),
		).rejects.toThrow(
			/cannot run inside saved-package, job, webhook, or app runtimes/,
		)
	},
)
