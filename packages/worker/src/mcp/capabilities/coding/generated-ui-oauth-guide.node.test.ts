import { expect, test } from 'vitest'
import { generatedUiOAuthGuideCapability } from './generated-ui-oauth-guide.ts'

test('generated_ui_oauth_guide distinguishes PKCE and server-side exchange helpers', async () => {
	const result = await generatedUiOAuthGuideCapability.handler(
		{},
		{
			env: {} as Env,
			callerContext: {
				baseUrl: 'https://kody.example',
				user: null,
			},
		},
	)

	expect(result.title).toBe('Generated UI OAuth guide')
	expect(result.body).toContain(
		'exchangePkceOAuthCode({ tokenUrl, code, redirectUri, clientId, codeVerifier, extraParams? })',
	)
	expect(result.body).toContain(
		'exchangeOAuthCodeWithSecrets({ tokenUrl, code, redirectUri, clientId, clientSecretSecretName, scope?, extraParams? })',
	)
	expect(result.body).toContain(
		'prefer `exchangePkceOAuthCode(...)` when the provider supports PKCE',
	)
	expect(result.body).toContain('`exchangeOAuthCodeWithSecrets(...)`')
	expect(result.body).toContain('run server-side')
	expect(result.body).toContain("import { kodyWidget } from '@kody/ui-utils'")
	expect(result.body).not.toContain('@kody/utils')
	expect(result.body).not.toContain('exchangeOAuthCode({ tokenUrl')
})
