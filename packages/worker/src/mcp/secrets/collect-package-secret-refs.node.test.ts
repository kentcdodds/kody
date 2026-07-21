import { expect, test } from 'vitest'
import { collectUserSecretRefsFromPackageSource } from './collect-package-secret-refs.ts'

test('collectUserSecretRefsFromPackageSource reads mounts and placeholders', () => {
	expect(
		collectUserSecretRefsFromPackageSource({
			secretMounts: {
				bot: { name: 'discordBotToken' },
				owned: { name: 'packageOwned', scope: 'package' },
			},
			files: {
				'index.ts': `
					await fetch('https://api.example.com', {
						headers: {
							Authorization: 'Bearer {{secret:xAccessToken}}',
							'X-Extra': '{{secret:discordBotToken|scope=user}}',
						},
					})
				`,
			},
		}),
	).toEqual([
		{ name: 'discordBotToken', scope: 'user' },
		{ name: 'xAccessToken', scope: 'user' },
	])
})
