import { expect, test, vi } from 'vitest'
import { env, exports as workerExports } from 'cloudflare:workers'
import { createExecuteExecutor } from './executor.ts'
import { saveSecret } from '#mcp/secrets/service.ts'
import migration0008Sql from '../../migrations/0008-secret-buckets.sql?raw'
import migration0009Sql from '../../migrations/0009-secret-allowed-hosts.sql?raw'
import migration0010Sql from '../../migrations/0010-secret-allowed-capabilities.sql?raw'

test('execute sandbox imports @kody/codemode-utils and refreshes a bearer token', async () => {
	const fetchSpy = vi
		.spyOn(globalThis, 'fetch')
		.mockImplementation(async (input, init) => {
			const request = new Request(input, init)
			if (request.url === 'https://auth.example.com/oauth/token') {
				expect(request.method).toBe('POST')
				expect(request.headers.get('content-type')).toBe(
					'application/x-www-form-urlencoded',
				)
				const body = await request.text()
				expect(body).toContain('grant_type=refresh_token')
				expect(body).toContain('client_id=spotify-client-id')
				expect(body).toContain('refresh_token=spotify-refresh-token')
				return Response.json({
					access_token: 'spotify-access-token',
				})
			}
			if (request.url === 'https://api.spotify.example.com/v1/me/player') {
				expect(request.headers.get('Authorization')).toBe(
					'Bearer spotify-access-token',
				)
				return Response.json({
					ok: true,
					receivedAuth: request.headers.get('Authorization'),
				})
			}
			throw new Error(`Unexpected fetch to ${request.url}`)
		})

	try {
		for (const migrationSql of [
			migration0008Sql,
			migration0009Sql,
			migration0010Sql,
		]) {
			for (const statement of migrationSql
				.split(';')
				.map((entry) => entry.trim())
				.filter(Boolean)) {
				await env.APP_DB.prepare(statement).run()
			}
		}
		await saveSecret({
			env,
			userId: 'user-123',
			scope: 'user',
			name: 'spotify-refresh-token',
			value: 'spotify-refresh-token',
			description: 'Spotify refresh token',
		})
		await env.APP_DB
			.prepare(
				'UPDATE secret_entries SET allowed_hosts = ? WHERE bucket_id = (SELECT id FROM secret_buckets WHERE user_id = ? AND scope = ? AND binding_key = ?) AND name = ?',
			)
			.bind(
				JSON.stringify(['auth.example.com']),
				'user-123',
				'user',
				'',
				'spotify-refresh-token',
			)
			.run()
		const executor = createExecuteExecutor({
			env,
			exports: workerExports,
			gatewayProps: {
				baseUrl: 'https://heykody.dev',
				userId: 'user-123',
				storageContext: null,
			},
		})
		const result = await executor.execute(
			[
				"import { createAuthenticatedFetch, refreshAccessToken } from '@kody/codemode-utils'",
				'',
				'export default async () => {',
				"  const accessToken = await refreshAccessToken('spotify')",
				"  const spotifyFetch = await createAuthenticatedFetch('spotify')",
				"  const response = await spotifyFetch('https://api.spotify.example.com/v1/me/player')",
				'  return {',
				'    accessToken,',
				'    payload: await response.json(),',
				'  }',
				'}',
			].join('\n'),
			[
				{
					name: 'codemode',
					fns: {
						async connector_get(args) {
							expect(args).toEqual({ name: 'spotify' })
							return {
								connector: {
									name: 'spotify',
									tokenUrl: 'https://auth.example.com/oauth/token',
									flow: 'pkce',
									clientIdValueName: 'spotify-client-id',
									accessTokenSecretName: 'spotify-access-token',
									refreshTokenSecretName: 'spotify-refresh-token',
									requiredHosts: ['auth.example.com'],
								},
							}
						},
						async value_get(args) {
							expect(args).toEqual({ name: 'spotify-client-id' })
							return {
								name: 'spotify-client-id',
								value: 'spotify-client-id',
								scope: 'user',
								description: 'Spotify OAuth client id',
							}
						},
					},
				},
			],
		)

		expect(result.error).toBeUndefined()
		expect(result.result).toEqual({
			accessToken: 'spotify-access-token',
			payload: {
				ok: true,
				receivedAuth: 'Bearer spotify-access-token',
			},
		})
		expect(fetchSpy).toHaveBeenCalledTimes(3)
	} finally {
		fetchSpy.mockRestore()
	}
})
