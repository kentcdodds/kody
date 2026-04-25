import { expect, test } from 'vitest'
import {
	createSecretHostApprovalToken,
	verifySecretHostApprovalToken,
} from './host-approval.ts'
import { encryptStringWithPurpose } from './crypto.ts'

const env = {
	COOKIE_SECRET: 'test-cookie-secret',
} as Pick<Env, 'COOKIE_SECRET'>

test('verifySecretHostApprovalToken accepts legacy tokens without kind', async () => {
	const now = Date.now()
	const token = await encryptStringWithPurpose(
		env,
		'secret-host-approval',
		JSON.stringify({
			userId: 'user-1',
			name: 'cloudflareToken',
			scope: 'user',
			requestedHost: 'API.Cloudflare.com',
			storageContext: null,
			iat: now,
			exp: now + 60_000,
		}),
	)

	await expect(verifySecretHostApprovalToken(env, token)).resolves.toEqual({
		kind: 'host',
		userId: 'user-1',
		name: 'cloudflareToken',
		scope: 'user',
		requestedHost: 'api.cloudflare.com',
		storageContext: null,
		iat: now,
		exp: now + 60_000,
	})
})

test('verifySecretHostApprovalToken still accepts new tokens with kind', async () => {
	const token = await createSecretHostApprovalToken(env, {
		userId: 'user-1',
		name: 'cloudflareToken',
		scope: 'user',
		requestedHost: 'api.cloudflare.com',
		storageContext: null,
	})

	await expect(verifySecretHostApprovalToken(env, token)).resolves.toMatchObject({
		kind: 'host',
		userId: 'user-1',
		name: 'cloudflareToken',
		scope: 'user',
		requestedHost: 'api.cloudflare.com',
		storageContext: null,
	})
})
