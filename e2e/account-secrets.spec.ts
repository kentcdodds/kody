import { expect, test } from './playwright-utils.ts'

const e2eCookieSecret = 'LOCAL_AND_PREVIEW_COOKIE_SECRET_32_CHARS_MINIMUM'
const secretHostApprovalPurpose = 'secret-host-approval'

async function saveSecret(
	page: Parameters<Parameters<typeof test>[1]>[0]['page'],
	input: {
		name: string
		description: string
		value: string
		allowedHosts?: Array<string>
		allowedCapabilities?: Array<string>
	},
) {
	const response = await page.request.post('/account/secrets.json', {
		data: {
			action: 'save',
			name: input.name,
			scope: 'user',
			appId: null,
			description: input.description,
			value: input.value,
			allowedHosts: input.allowedHosts ?? [],
			allowedCapabilities: input.allowedCapabilities ?? [],
		},
		headers: { 'Content-Type': 'application/json' },
	})
	expect(response.ok()).toBeTruthy()
}

function bytesToBase64Url(bytes: Uint8Array) {
	let binary = ''
	for (const value of bytes) {
		binary += String.fromCharCode(value)
	}
	return btoa(binary)
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replaceAll('=', '')
}

async function deriveEncryptionKey(cookieSecret: string, purpose: string) {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(`${purpose}:${cookieSecret}`),
	)
	return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, [
		'encrypt',
		'decrypt',
	])
}

async function encryptStringWithPurpose(purpose: string, value: string) {
	const key = await deriveEncryptionKey(e2eCookieSecret, purpose)
	const iv = crypto.getRandomValues(new Uint8Array(12))
	const ciphertext = await crypto.subtle.encrypt(
		{
			name: 'AES-GCM',
			iv,
		},
		key,
		new TextEncoder().encode(value),
	)
	return `${bytesToBase64Url(iv)}.${bytesToBase64Url(
		new Uint8Array(ciphertext),
	)}`
}

async function createHostApprovalToken(input: {
	userId: string
	name: string
	requestedHost: string
}) {
	const now = Date.now()
	const token = await encryptStringWithPurpose(
		secretHostApprovalPurpose,
		JSON.stringify({
			kind: 'host',
			userId: input.userId,
			name: input.name,
			scope: 'user',
			requestedHost: input.requestedHost,
			storageContext: null,
			iat: now,
			exp: now + 60_000,
		}),
	)
	return `host:${token}`
}

async function createStableUserIdFromEmail(email: string) {
	const normalized = email.trim().toLowerCase()
	const data = new TextEncoder().encode(normalized)
	const hash = await crypto.subtle.digest('SHA-256', data)
	return Array.from(new Uint8Array(hash), (byte) =>
		byte.toString(16).padStart(2, '0'),
	).join('')
}

test('switching secrets updates detail view without a full reload', async ({
	page,
	login,
}) => {
	await login()

	const nonce = Date.now().toString(36)
	const firstSecret = {
		name: `secret-switch-a-${nonce}`,
		description: `First router test secret ${nonce}`,
		value: `value-a-${nonce}`,
	}
	const secondSecret = {
		name: `secret-switch-b-${nonce}`,
		description: `Second router test secret ${nonce}`,
		value: `value-b-${nonce}`,
	}

	await saveSecret(page, firstSecret)
	await saveSecret(page, secondSecret)

	await page.goto(`/account/secrets/user/${firstSecret.name}`)
	await expect(
		page.getByRole('heading', { level: 2, name: firstSecret.name }),
	).toBeVisible()
	await expect(page.getByLabel('Description')).toHaveValue(
		firstSecret.description,
	)

	await page.evaluate(() => {
		;(
			window as typeof window & { __secretRouteMarker?: string }
		).__secretRouteMarker = 'still-here'
	})

	await page.getByRole('button', { name: secondSecret.name }).click()

	await expect(page).toHaveURL(
		new RegExp(`/account/secrets/user/${secondSecret.name}$`),
	)
	await expect(
		page.getByRole('heading', { level: 2, name: secondSecret.name }),
	).toBeVisible()
	await expect(page.getByLabel('Description')).toHaveValue(
		secondSecret.description,
	)
	await expect(
		page.getByPlaceholder('Enter the secret value').first(),
	).toHaveValue(secondSecret.value)
	await expect(
		page.evaluate(
			() =>
				(window as typeof window & { __secretRouteMarker?: string })
					.__secretRouteMarker,
		),
	).resolves.toBe('still-here')
})
test('landing on an approval link shows already added when the host is present', async ({
	page,
	login,
}) => {
	await login()

	const nonce = Date.now().toString(36)
	const secret = {
		name: `cloudflare-token-${nonce}`,
		description: `Cloudflare token ${nonce}`,
		value: `token-${nonce}`,
		allowedHosts: ['api.cloudflare.com'],
	}

	await saveSecret(page, secret)

	await page.goto(
		`/account/secrets/user/${secret.name}?allowed-host=api.cloudflare.com&request=stale-token`,
	)

	await expect(
		page.getByRole('heading', { level: 2, name: secret.name }),
	).toBeVisible()
	const alreadyAddedNotice = page.getByRole('status')
	await expect(alreadyAddedNotice).toBeVisible()
	await expect(alreadyAddedNotice).toContainText('api.cloudflare.com')
	await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0)
})

test('generated host approval link shows one-click approve and persists host', async ({
	page,
	login,
}) => {
	const user = await login()
	const nonce = Date.now().toString(36)
	const secret = {
		name: `fly-token-${nonce}`,
		description: `Fly token ${nonce}`,
		value: `token-${nonce}`,
	}
	await saveSecret(page, secret)

	const requestedHost = 'api.fly.io'
	const token = await createHostApprovalToken({
		userId: await createStableUserIdFromEmail(user.email),
		name: secret.name,
		requestedHost,
	})
	await page.goto(
		`/account/secrets/user/${secret.name}?allowed-host=${requestedHost}&request=${encodeURIComponent(
			token,
		)}`,
	)

	const approvalCard = page.getByRole('heading', {
		level: 2,
		name: 'Approve secret access',
	})
	await expect(approvalCard).toBeVisible()
	await expect(page.getByText(requestedHost)).toBeVisible()
	await page.getByRole('button', { name: 'Approve' }).click()
	await expect(page.getByRole('alert')).toContainText(
		'Approved requested host.',
	)
	await expect(page).toHaveURL(
		new RegExp(`/account/secrets/user/${secret.name}`),
	)
	await expect(page.getByPlaceholder('api.example.com').first()).toHaveValue(
		requestedHost,
	)
})
