import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { expect, test, vi } from 'vitest'
import { sessionRequestContext } from '#worker/test-support/request-context.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import {
	executeGatewayFetch,
	expandSecretPlaceholders,
	secretResolutionHeaderName,
} from '#mcp/fetch-gateway.ts'
import {
	parseHostApprovalRequiredBatchMessage,
	parsePackageAccessRequiredMessage,
} from '#mcp/secrets/errors.ts'
import { buildBasicAuthSecretPlaceholder } from '#mcp/secrets/placeholders.ts'
import * as secretPlacement from '#mcp/secrets/secret-placement.ts'
import * as secretService from '#mcp/secrets/service.ts'
import * as communityRepo from '#worker/community/repo.ts'
import * as credentialResolution from '#worker/credentials/resolve-credential.ts'
import {
	isActiveOrgQuery,
	isOrgBindingMembershipQuery,
	mockPersonalOrgBindingRow,
} from '#worker/test-support/org-binding-query.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import * as packageRepo from '#worker/package-registry/repo.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import * as integrationCredentials from '#worker/integrations/credentials.ts'
import * as integrationPackageAccess from '#worker/integrations/package-access.ts'
import * as integrationService from '#worker/integrations/service.ts'
import * as providerService from '#mcp/secrets/secret-providers/service.ts'
import * as usageModule from '#worker/usage/record-usage.ts'
import { IntegrationHostNotAllowedError } from '#mcp/execute-modules/integration-host-allowlist.ts'

const userMeter = createInMemoryUserMeterEnv()
const env = {
	APP_DB: {
		prepare(query: string) {
			const normalizedQuery = query.replace(/\s+/g, ' ').trim().toLowerCase()
			return {
				bind(...params: Array<unknown>) {
					return {
						async run() {
							return { meta: { changes: 1 } }
						},
						async first() {
							if (isActiveOrgQuery(normalizedQuery)) return { ok: 1 }
							if (isOrgBindingMembershipQuery(normalizedQuery)) {
								return mockPersonalOrgBindingRow(String(params[1]), 'ada')
							}
							if (
								normalizedQuery.includes('where stable_user_id') &&
								params[0] !== 'user-123'
							) {
								throw new Error(
									'Account reverse-resolution must bind the acting userId.',
								)
							}
							return null
						},
						async all() {
							return { results: [], meta: { changes: 0 } }
						},
					}
				},
			}
		},
	} as unknown as D1Database,
	...userMeter.env,
	COOKIE_SECRET: 'test-cookie-secret',
	SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
} as unknown as Env

const props = {
	baseUrl: 'https://example.com',
	userId: ownerIdFromStored('user-123'),
	email: null,
	request: sessionRequestContext('user-123', 'ada'),
	storageContext: null,
}

type GatewayProps = Parameters<typeof expandSecretPlaceholders>[0]['props']

const expand = (request: Request, runProps: GatewayProps = props) =>
	expandSecretPlaceholders({ request, props: runProps, env }).then(
		({ request: expanded }) => expanded,
	)

function packageRunProps(
	packageId: string,
	extra: Partial<GatewayProps> = {},
): GatewayProps {
	return {
		...props,
		storageContext: {
			sessionId: null,
			appId: packageId,
			packageId,
			storageId: packageId,
		},
		...extra,
	}
}

function savedPackage(
	id: string,
	kodyId: string,
	{ userId = 'user-123', owner = 'user', sourceId = 'source-1' } = {},
): SavedPackageRecord {
	return {
		id,
		userId: ownerIdFromStored(userId),
		kodyId,
		name: `@${owner}/${kodyId}`,
		description: '',
		tags: [],
		searchText: null,
		hasApp: false,
		hasSkills: false,
		hidden: false,
		isPrivate: false,
		lockedAt: null,
		sourceId,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
	}
}

function communityFork(forkedPackageId: string, targetKodyId: string) {
	return {
		id: 'fork-1',
		listingId: 'listing-1',
		forkerUserId: 'user-123',
		originCommit: 'abc123',
		forkedPackageId,
		forkedSourceId: 'source-1',
		targetKodyId,
		createdAt: '2026-01-01T00:00:00.000Z',
		adoptedAt: null,
		adoptionNote: null,
	}
}

function userSecret(
	value: string,
	allowedHosts: Array<string>,
	allowedPackages: Array<string> = [],
): secretService.ResolvedSecret {
	return {
		found: true,
		value,
		scope: 'user',
		allowedHosts,
		allowedPackages,
	}
}

// Node's Request rejects path-only URLs; workerd allows them for kody outbound fetch.
const createPathOnlyRequest = (url: string) =>
	({
		url,
		method: 'GET',
		headers: new Headers(),
		redirect: 'follow',
		credentials: 'same-origin',
		mode: 'cors',
		cache: 'default',
		integrity: '',
		keepalive: false,
		signal: undefined,
		text: async () => '',
	}) as unknown as Request

async function readHostApprovals(promise: Promise<unknown>) {
	const error = await promise.then(
		() => {
			throw new Error('Expected host approval error.')
		},
		(caught: unknown) => caught,
	)
	return parseHostApprovalRequiredBatchMessage(getErrorMessage(error))
}

const isPackageAccessRequiredFor = (packageName: string) => (error: unknown) =>
	parsePackageAccessRequiredMessage(getErrorMessage(error))?.packageName ===
	packageName

test('fetch gateway blocks or expands secret placeholders based on host approval', async () => {
	const createRequest = () =>
		new Request('https://example.com/api', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: 'Bearer {{secret:spotifyRefreshToken|scope=user}}',
			},
			body: JSON.stringify({ query: 'me' }),
		})
	const resolveSpy = vi
		.spyOn(secretService, 'resolveSecret')
		.mockResolvedValue(userSecret('secret-value', []))

	expect(await readHostApprovals(expand(createRequest()))).toEqual({
		entries: [
			expect.objectContaining({
				secretName: 'spotifyRefreshToken',
				host: 'example.com',
				approvalUrl: expect.stringMatching(
					/\/connect\/secrets\?name=spotifyRefreshToken&hosts=example\.com$/,
				),
			}),
		],
		bulkApprovalUrl: null,
	})

	resolveSpy.mockResolvedValue(userSecret('secret-value', ['example.com']))
	const transformed = await expand(createRequest())
	expect(transformed.headers.get('Authorization')).toBe('Bearer secret-value')
	expect(await transformed.text()).toBe(JSON.stringify({ query: 'me' }))
})

test('fetch gateway fills placeholders in the URL path and query on an allowed host', async () => {
	const resolveSpy = vi
		.spyOn(secretService, 'resolveSecret')
		.mockImplementation(async ({ name }) =>
			userSecret(`${name}-value`, ['api.telegram.org', 'api.example.com']),
		)

	// Request serialization percent-encodes `{` / `}` in the path.
	const pathRequest = new Request(
		'https://api.telegram.org/bot{{secret:telegramBotToken|scope=user}}/getMe',
	)
	expect(pathRequest.url).toContain('%7B%7Bsecret:telegramBotToken')
	expect((await expand(pathRequest)).url).toBe(
		'https://api.telegram.org/bottelegramBotToken-value/getMe',
	)

	const literalQuery = await expand(
		new Request(
			'https://api.example.com/search?q=cats&key={{secret:queryToken|scope=user}}',
		),
	)
	expect(new URL(literalQuery.url).searchParams.get('key')).toBe(
		'queryToken-value',
	)
	expect(new URL(literalQuery.url).searchParams.get('q')).toBe('cats')

	const builtUrl = new URL('https://api.example.com/v1')
	builtUrl.search = new URLSearchParams({
		key: '{{secret:queryToken}}',
	}).toString()
	expect(builtUrl.href).toContain('%7B%7Bsecret%3AqueryToken%7D%7D')
	const built = await expand(new Request(builtUrl))
	expect(new URL(built.url).searchParams.get('key')).toBe('queryToken-value')

	// A URL without a placeholder is left exactly as written.
	const plainUrl = 'https://api.example.com/a%20b?x=%7Bliteral%7D&y=1+2'
	expect((await expand(new Request(plainUrl))).url).toBe(plainUrl)
	expect(resolveSpy).toHaveBeenCalledTimes(3)
})

test('fetch gateway fills placeholders in JSON, form, and text bodies on an allowed host', async () => {
	vi.spyOn(secretService, 'resolveSecret').mockImplementation(
		async ({ name }) =>
			userSecret(name === 'quoted' ? 'pa"ss\\word' : `${name}-value`, [
				'api.example.com',
			]),
	)
	const send = (contentType: string, body: string) =>
		expand(
			new Request('https://api.example.com/v1/session', {
				method: 'POST',
				headers: { 'Content-Type': contentType },
				body,
			}),
		).then((request) => request.text())

	const json = await send(
		'application/json',
		JSON.stringify({
			identifier: '{{secret:handle}}',
			password: '{{secret:quoted|scope=user}}',
		}),
	)
	expect(JSON.parse(json)).toEqual({
		identifier: 'handle-value',
		password: 'pa"ss\\word',
	})

	const form = await send(
		'application/x-www-form-urlencoded',
		new URLSearchParams({
			grant_type: 'refresh_token',
			refresh_token: '{{secret:refreshToken|scope=user}}',
			password: '{{secret:quoted}}',
		}).toString(),
	)
	expect(Object.fromEntries(new URLSearchParams(form))).toEqual({
		grant_type: 'refresh_token',
		refresh_token: 'refreshToken-value',
		password: 'pa"ss\\word',
	})

	expect(await send('text/plain', 'token={{secret:plain}};')).toBe(
		'token=plain-value;',
	)

	// A body without a placeholder is forwarded byte for byte.
	const untouched = '{"a": 1,   "b": "{literal}"}'
	expect(await send('application/json', untouched)).toBe(untouched)
})

test('fetch gateway fills integration tokens in the body against the integration hosts', async () => {
	vi.spyOn(credentialResolution, 'resolveCredential').mockImplementation(
		async ({ credential }) => {
			expect(credential).toMatchObject({
				use: 'integration-token',
				name: 'github',
				requestHost: 'api.github.com',
			})
			return 'gho_value'
		},
	)
	const sent = await expand(
		new Request('https://api.github.com/graphql', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ token: '{{integration-token:github}}' }),
		}),
	)
	expect(JSON.parse(await sent.text())).toEqual({ token: 'gho_value' })
})

test('fetch gateway headers-only fills headers and sends a body that quotes placeholder syntax verbatim', async () => {
	const resolveSpy = vi
		.spyOn(secretService, 'resolveSecret')
		.mockResolvedValue(userSecret('secret-value', ['api.example.com']))
	const issueBody = JSON.stringify({
		title: 'Placeholder docs',
		body: 'Use {{secret:githubToken|scope=user}} or {{secret:githubToken}} in a header.',
	})
	const sent = await expand(
		new Request(
			'https://api.example.com/repos/o/r/issues?q={{secret:githubToken}}',
			{
				method: 'POST',
				headers: {
					Authorization: 'Bearer {{secret:githubToken|scope=user}}',
					'Content-Type': 'application/json',
					[secretResolutionHeaderName]: 'headers-only',
				},
				body: issueBody,
			},
		),
	)
	expect(sent.headers.get('Authorization')).toBe('Bearer secret-value')
	expect(sent.headers.get(secretResolutionHeaderName)).toBeNull()
	expect(new URL(sent.url).searchParams.get('q')).toBe('{{secret:githubToken}}')
	const sentBody = await sent.text()
	expect(sentBody).toBe(issueBody)
	expect(sentBody).not.toContain('secret-value')
	expect(resolveSpy).toHaveBeenCalledTimes(1)
})

test('fetch gateway refuses a placeholder over plain HTTP, naming the slot and host, before resolving', async () => {
	const resolveSpy = vi
		.spyOn(secretService, 'resolveSecret')
		.mockResolvedValue(userSecret('secret-value', ['api.example.com']))
	const credentialSpy = vi.spyOn(credentialResolution, 'resolveCredential')
	const requests = [
		() =>
			new Request('http://api.example.com/v1', {
				headers: { Authorization: 'Bearer {{secret:apiToken}}' },
			}),
		() => new Request('http://api.example.com/v1?key={{secret:apiToken}}'),
		() =>
			new Request('http://api.example.com/v1', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ token: '{{secret:apiToken}}' }),
			}),
	]
	for (const request of requests) {
		await expect(expand(request())).rejects.toBeInstanceOf(
			secretPlacement.SecretPlacementError,
		)
		await expect(expand(request())).rejects.toThrow(
			/^Secret "apiToken" cannot be sent to host "api\.example\.com" over plain HTTP\. The fetch gateway fills secrets only over HTTPS\./,
		)
		await expect(expand(request())).rejects.toMatchObject({
			code: 'credential_placement_refused',
			slot: 'apiToken',
			message: expect.stringMatching(
				/\(credential_placement_refused, slot "apiToken"\)$/,
			),
		})
	}
	await expect(
		expand(
			new Request('http://api.example.com/v1', {
				method: 'POST',
				body: '{{integration-token:github}}',
			}),
		),
	).rejects.toThrow(
		/^Integration token "github" cannot be sent to host "api\.example\.com" over plain HTTP\./,
	)
	// Plain HTTP without a placeholder is just a fetch.
	expect((await expand(new Request('http://api.example.com/v1'))).url).toBe(
		'http://api.example.com/v1',
	)
	expect(resolveSpy).not.toHaveBeenCalled()
	expect(credentialSpy).not.toHaveBeenCalled()
})

test('fetch gateway refuses a placeholder in the URL host or user info', async () => {
	const resolveSpy = vi.spyOn(secretService, 'resolveSecret')
	await expect(
		expand(
			createPathOnlyRequest('https://{{secret:user}}:pw@api.example.com/v1'),
		),
	).rejects.toThrow(
		/^Secret "user" is in the host or user info of the request URL\./,
	)
	expect(resolveSpy).not.toHaveBeenCalled()
})

test('fetch gateway refuses a body placeholder on a host the secret does not allow, naming the slot and host', async () => {
	vi.spyOn(secretService, 'resolveSecret').mockResolvedValue(
		userSecret('secret-value', ['bsky.social']),
	)
	const refused = expand(
		new Request('https://evil.example/xrpc/session', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ password: '{{secret:appPassword}}' }),
		}),
	)
	const error = await refused.catch((caught: unknown) => caught)
	expect(error).toBeInstanceOf(secretPlacement.SecretPlacementError)
	expect(error).toMatchObject({
		code: 'credential_placement_refused',
		slot: 'appPassword',
	})
	expect(parseHostApprovalRequiredBatchMessage(getErrorMessage(error))).toEqual(
		{
			entries: [
				expect.objectContaining({
					secretName: 'appPassword',
					host: 'evil.example',
				}),
			],
			bulkApprovalUrl: null,
		},
	)

	vi.spyOn(credentialResolution, 'resolveCredential').mockRejectedValueOnce(
		new IntegrationHostNotAllowedError('github', 'evil.example'),
	)
	await expect(
		expand(
			new Request('https://evil.example/v1', {
				method: 'POST',
				body: 'token={{integration-token:github}}',
			}),
		),
	).rejects.toMatchObject({
		code: 'credential_placement_refused',
		slot: 'github',
		message: expect.stringContaining('evil.example'),
	})
})

test('fetch gateway bulk host approval uses the secret scope, not the package runtime context', async () => {
	vi.spyOn(packageRepo, 'getSavedPackageById').mockResolvedValue(
		savedPackage('pkg-1', 'example-package'),
	)
	vi.spyOn(
		communityRepo,
		'getCommunityForkByForkedPackageId',
	).mockResolvedValue(null)
	vi.spyOn(secretService, 'resolveSecret').mockResolvedValue(
		userSecret('secret-value', [], ['pkg-1']),
	)

	const approvals = await readHostApprovals(
		expand(
			new Request('https://api.example.com/v1', {
				headers: {
					Authorization: 'Bearer {{secret:accessToken|scope=user}}',
					'X-Refresh': '{{secret:refreshToken|scope=user}}',
				},
			}),
			packageRunProps('pkg-1'),
		),
	)
	expect(approvals?.bulkApprovalUrl).toBe(
		'https://example.com/connect/secrets?names=accessToken%2CrefreshToken&hosts=api.example.com',
	)
	expect(approvals?.bulkApprovalUrl).not.toContain('scope=package')
	expect(approvals?.entries[0]?.approvalUrl).not.toContain('scope=package')
})

test('fetch gateway requires package approval before resolving user secrets', async () => {
	const request = () =>
		new Request('https://example.com/api', {
			headers: { Authorization: 'Bearer {{secret:userToken|scope=user}}' },
		})
	const packageSpy = vi
		.spyOn(packageRepo, 'getSavedPackageById')
		.mockResolvedValue(savedPackage('pkg-1', 'example-package'))
	const forkSpy = vi
		.spyOn(communityRepo, 'getCommunityForkByForkedPackageId')
		.mockResolvedValue(communityFork('pkg-1', 'example-package'))
	const resolveSpy = vi
		.spyOn(secretService, 'resolveSecret')
		.mockResolvedValueOnce(userSecret('secret-value', ['example.com'], []))
		.mockResolvedValueOnce(
			userSecret('secret-value', ['example.com'], ['pkg-1']),
		)

	await expect(expand(request(), packageRunProps('pkg-1'))).rejects.toSatisfy(
		isPackageAccessRequiredFor('example-package'),
	)
	const transformed = await expand(request(), packageRunProps('pkg-1'))
	expect(transformed.headers.get('Authorization')).toBe('Bearer secret-value')
	expect(packageSpy).toHaveBeenCalledTimes(1)
	expect(forkSpy).toHaveBeenCalledTimes(1)
	expect(resolveSpy).toHaveBeenCalledTimes(2)
})

test('fetch gateway authorizes {{secret}} as the stamped package, not the importing run', async () => {
	const request = (authorityPackageId?: string) => {
		const headers = new Headers({
			Authorization: 'Bearer {{secret:userToken|scope=user}}',
		})
		if (authorityPackageId) {
			headers.set('x-kody-secret-authority', authorityPackageId)
		}
		return new Request('https://example.com/api', { headers })
	}
	const runProps = packageRunProps('pkg-b', {
		grantedSecretAuthorityPackageIds: ['pkg-a', 'pkg-b'],
	})
	vi.spyOn(packageRepo, 'getSavedPackageById').mockImplementation(
		async (_db, input) =>
			input.packageId === 'pkg-a'
				? savedPackage('pkg-a', 'wake-owner', { sourceId: 'source-a' })
				: savedPackage('pkg-b', 'importer', { sourceId: 'source-b' }),
	)
	vi.spyOn(
		communityRepo,
		'getCommunityForkByForkedPackageId',
	).mockImplementation(async (_db, input) =>
		communityFork(
			input.forkedPackageId,
			input.forkedPackageId === 'pkg-a' ? 'wake-owner' : 'importer',
		),
	)
	vi.spyOn(secretService, 'resolveSecret').mockResolvedValue(
		userSecret('secret-value', ['example.com'], ['pkg-a']),
	)

	const stamped = await expand(request('pkg-a'), runProps)
	expect(stamped.headers.get('Authorization')).toBe('Bearer secret-value')
	expect(stamped.headers.get('x-kody-secret-authority')).toBeNull()

	// Unstamped and unrelated stamps authorize as the importing run. An empty
	// grant set is an installed empty set, not "no set", and an omitted set is
	// also fail-closed: a forged pkg-a header must not select that authority.
	for (const [authority, extra] of [
		[undefined, {}],
		['pkg-unrelated', {}],
		['pkg-a', { grantedSecretAuthorityPackageIds: [] }],
		['pkg-a', { grantedSecretAuthorityPackageIds: undefined }],
	] as const) {
		await expect(
			expand(request(authority), { ...runProps, ...extra }),
		).rejects.toSatisfy(isPackageAccessRequiredFor('importer'))
	}
})

test('fetch gateway gates integration tokens by the connection grant and requiredHosts', async () => {
	const integrationRequest = (url: string) =>
		new Request(url, {
			headers: { Authorization: 'Bearer {{integration-token:google}}' },
		})
	const packageSpy = vi
		.spyOn(packageRepo, 'getSavedPackageById')
		.mockResolvedValue(savedPackage('pkg-1', 'example-package'))
	const forkSpy = vi
		.spyOn(communityRepo, 'getCommunityForkByForkedPackageId')
		.mockResolvedValue(communityFork('pkg-1', 'example-package'))
	const resolveSpy = vi
		.spyOn(secretService, 'resolveSecret')
		.mockResolvedValue(userSecret('oauth-access', ['example.com'], []))
	const tokenSpy = vi
		.spyOn(integrationCredentials, 'resolveIntegrationAccessToken')
		.mockResolvedValue('oauth-access')
	const grantSpy = vi
		.spyOn(integrationPackageAccess, 'assertCanUseIntegration')
		.mockResolvedValue(undefined)
	const joinedSpy = vi
		.spyOn(integrationService, 'getJoinedIntegration')
		.mockResolvedValue({
			lane: 'user',
			app: { apiBaseUrl: 'https://example.com' },
			connection: { requiredHosts: ['example.com'] },
		} as never)

	// Integration-owned token names are gated by the connection grant, not
	// secret allowed_packages.
	const transformed = await expand(
		integrationRequest('https://example.com/api'),
		packageRunProps('pkg-1'),
	)
	expect(transformed.headers.get('Authorization')).toBe('Bearer oauth-access')
	expect(grantSpy).toHaveBeenCalledWith(
		expect.objectContaining({ name: 'google', packageId: 'pkg-1' }),
	)
	expect(tokenSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: ownerIdFromStored('user-123'),
			name: 'google',
		}),
	)
	expect(resolveSpy).not.toHaveBeenCalled()
	expect(packageSpy).not.toHaveBeenCalled()
	expect(forkSpy).not.toHaveBeenCalled()

	// Package export imported into execute: run has no packageId, stamp header
	// carries the callee package for integrationLock grants (same as secrets).
	grantSpy.mockClear()
	const stampedFromExecute = await expand(
		(() => {
			const headers = new Headers({
				Authorization: 'Bearer {{integration-token:google}}',
			})
			headers.set('x-kody-secret-authority', 'pkg-1')
			return new Request('https://example.com/api', { headers })
		})(),
		{
			...props,
			storageContext: {
				sessionId: null,
				appId: null,
				packageId: null,
				storageId: null,
			},
			grantedSecretAuthorityPackageIds: ['pkg-1'],
		},
	)
	expect(stampedFromExecute.headers.get('Authorization')).toBe(
		'Bearer oauth-access',
	)
	expect(grantSpy).toHaveBeenCalledWith(
		expect.objectContaining({ name: 'google', packageId: 'pkg-1' }),
	)

	// A host outside requiredHosts is refused before the token resolves.
	joinedSpy.mockResolvedValue({
		lane: 'user',
		app: { apiBaseUrl: 'https://www.googleapis.com' },
		connection: {
			requiredHosts: ['www.googleapis.com', 'oauth2.googleapis.com'],
		},
	} as never)
	await expect(
		expand(integrationRequest('https://evil.example/steal')),
	).rejects.toThrow('does not allow requests to host "evil.example"')

	// A token without a joined connection is refused.
	joinedSpy.mockResolvedValue(null)
	await expect(
		expand(integrationRequest('https://evil.example/steal')),
	).rejects.toThrow('does not have a stored access token')
	expect(joinedSpy).toHaveBeenCalledTimes(4)
	expect(joinedSpy).toHaveBeenLastCalledWith(
		expect.objectContaining({
			userId: ownerIdFromStored('user-123'),
			name: 'google',
		}),
	)
	expect(tokenSpy).toHaveBeenCalledTimes(2)
})

test('opt-out header controls secret resolution and strips itself from forwarded requests', async () => {
	const resolveSpy = vi.spyOn(secretService, 'resolveSecret')

	const offTransformed = await expand(
		new Request('https://discord.com/api/channels/1/messages', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				[secretResolutionHeaderName]: 'off',
			},
			body: JSON.stringify({
				content: 'Use {{secret:name}} in your fetch call.',
			}),
		}),
	)
	expect(offTransformed.headers.get(secretResolutionHeaderName)).toBeNull()
	expect(await offTransformed.text()).toBe(
		JSON.stringify({ content: 'Use {{secret:name}} in your fetch call.' }),
	)
	expect(offTransformed.url).toBe('https://discord.com/api/channels/1/messages')
	expect(resolveSpy).not.toHaveBeenCalled()

	resolveSpy.mockResolvedValue(userSecret('secret-value', ['example.com']))
	const onTransformed = await expand(
		new Request('https://example.com/api', {
			method: 'POST',
			headers: {
				Authorization: 'Bearer {{secret:spotifyRefreshToken|scope=user}}',
				[secretResolutionHeaderName]: 'on',
			},
			body: '{}',
		}),
	)
	expect(onTransformed.headers.get('Authorization')).toBe('Bearer secret-value')
	expect(onTransformed.headers.get(secretResolutionHeaderName)).toBeNull()

	await expect(
		expand(
			new Request('https://example.com/api', {
				headers: { [secretResolutionHeaderName]: 'of' },
			}),
		),
	).rejects.toThrow(`Invalid ${secretResolutionHeaderName} header value "of"`)
})

test('fetch gateway preserves request bodies and honors opt-out for text and binary payloads', async () => {
	const encoder = new TextEncoder()
	const concatBytes = (...parts: Array<Uint8Array>) => {
		const body = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0))
		let offset = 0
		for (const part of parts) {
			body.set(part, offset)
			offset += part.length
		}
		return body
	}
	const bodyBytes = async (request: Request) =>
		new Uint8Array(await (await expand(request)).arrayBuffer())
	const resolveSpy = vi
		.spyOn(secretService, 'resolveSecret')
		.mockResolvedValue(
			userSecret('secret-value', ['discord.com', 'example.com']),
		)

	const boundary = '----TestBoundary123'
	const multipartBody = concatBytes(
		encoder.encode(
			`--${boundary}\r\nContent-Disposition: form-data; name="files[0]"; filename="image.png"\r\nContent-Type: image/png\r\n\r\n`,
		),
		new Uint8Array([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x01,
		]),
		encoder.encode(`\r\n--${boundary}--\r\n`),
	)
	const discordMultipart = (
		contentBoundary: string,
		body: Uint8Array<ArrayBuffer>,
		extraHeaders: Record<string, string> = {},
	) =>
		new Request('https://discord.com/api/channels/1/messages', {
			method: 'POST',
			headers: {
				Authorization: 'Bot {{secret:discordBotToken|scope=user}}',
				'Content-Type': `multipart/form-data; boundary=${contentBoundary}`,
				...extraHeaders,
			},
			body,
		})
	const transformedMultipart = await expand(
		discordMultipart(boundary, multipartBody),
	)
	expect(transformedMultipart.headers.get('Authorization')).toBe(
		'Bot secret-value',
	)
	expect(new Uint8Array(await transformedMultipart.arrayBuffer())).toEqual(
		multipartBody,
	)

	// Multipart bodies are opaque: text parts that quote placeholders are
	// forwarded unchanged and only the header placeholder resolves.
	const textBoundary = '----KodyDiscordBoundaryTest'
	const payloadJson = JSON.stringify({
		content: 'Feedback mentioned {{secret:BraveSearch}} in the docs.',
	})
	const textFile = [
		'SUMMARY',
		'secret placeholder example',
		'',
		'DETAILS',
		'Use {{secret:BraveSearch}} or {{secret:kodyPathProbe|scope=user}}.',
	].join('\n')
	const textMultipartBody = concatBytes(
		encoder.encode(
			`--${textBoundary}\r\nContent-Disposition: form-data; name="payload_json"\r\nContent-Type: application/json\r\n\r\n${payloadJson}\r\n`,
		),
		encoder.encode(
			`--${textBoundary}\r\nContent-Disposition: form-data; name="files[0]"; filename="feedback.txt"\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${textFile}\r\n`,
		),
		encoder.encode(`--${textBoundary}--\r\n`),
	)
	expect(() =>
		new TextDecoder('utf-8', { fatal: true }).decode(textMultipartBody),
	).not.toThrow()
	resolveSpy.mockClear()
	resolveSpy.mockImplementation(async ({ name }) =>
		name === 'discordBotToken'
			? userSecret('secret-value', ['discord.com'])
			: {
					found: false,
					value: null,
					scope: null,
					allowedHosts: [],
					allowedPackages: [],
				},
	)
	const transformedTextMultipart = await expand(
		discordMultipart(textBoundary, textMultipartBody),
	)
	expect(transformedTextMultipart.headers.get('Authorization')).toBe(
		'Bot secret-value',
	)
	expect(new Uint8Array(await transformedTextMultipart.arrayBuffer())).toEqual(
		textMultipartBody,
	)
	expect(resolveSpy).toHaveBeenCalledTimes(1)
	expect(resolveSpy).toHaveBeenCalledWith(
		expect.objectContaining({ name: 'discordBotToken' }),
	)

	// BOM-prefixed JSON, binary, and opt-out bodies pass through byte-for-byte
	// without resolution.
	resolveSpy.mockClear()
	resolveSpy.mockResolvedValue(
		userSecret('secret-value', ['discord.com', 'example.com']),
	)
	const bomBody = concatBytes(
		new Uint8Array([0xef, 0xbb, 0xbf]),
		encoder.encode('{"note":"bom-prefixed json"}'),
	)
	expect(
		await bodyBytes(
			new Request('https://example.com/api', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: bomBody,
			}),
		),
	).toEqual(bomBody)
	const binaryPlaceholderBody = concatBytes(
		new Uint8Array([0xff]),
		encoder.encode('{{secret:name|scope=user}}'),
		new Uint8Array([0xfe]),
	)
	expect(
		await bodyBytes(
			new Request('https://example.com/upload', {
				method: 'PUT',
				body: binaryPlaceholderBody,
			}),
		),
	).toEqual(binaryPlaceholderBody)
	expect(
		await bodyBytes(
			new Request('https://example.com/upload', {
				method: 'PUT',
				headers: { [secretResolutionHeaderName]: 'off' },
				body: binaryPlaceholderBody,
			}),
		),
	).toEqual(binaryPlaceholderBody)
	const optOutBinaryBody = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
	expect(
		await bodyBytes(
			new Request('https://example.com/upload', {
				method: 'POST',
				headers: { [secretResolutionHeaderName]: 'off' },
				body: optOutBinaryBody,
			}),
		),
	).toEqual(optOutBinaryBody)
	expect(resolveSpy).not.toHaveBeenCalled()
})

test('fetch gateway derives Basic Auth header and enforces host approval', async () => {
	const placeholder = buildBasicAuthSecretPlaceholder({
		usernameSecret: 'paypalClientId',
		passwordSecret: 'paypalClientSecret',
		scope: 'user',
	})
	const values: Record<string, string> = {
		paypalClientId: 'client-id',
		paypalClientSecret: 'client-secret',
	}
	const resolveSpy = vi.spyOn(secretService, 'resolveSecret')
	const mockPaypalSecrets = (hostsByName: Record<string, Array<string>>) =>
		resolveSpy.mockImplementation(async ({ name }) =>
			name in hostsByName
				? userSecret(values[name]!, hostsByName[name]!)
				: {
						found: false,
						value: null,
						scope: null,
						allowedHosts: [],
						allowedPackages: [],
					},
		)
	const tokenRequest = (authorization: string, init: RequestInit = {}) =>
		new Request('https://api-m.paypal.com/v1/oauth2/token', {
			...init,
			headers: { Authorization: authorization, ...init.headers },
		})
	const paypalHost = ['api-m.paypal.com']
	mockPaypalSecrets({
		paypalClientId: paypalHost,
		paypalClientSecret: paypalHost,
	})

	const transformed = await expand(
		tokenRequest(placeholder, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				grant_type: 'client_credentials',
			}).toString(),
		}),
	)
	const expectedBasic = `Basic ${btoa('client-id:client-secret')}`
	expect(transformed.headers.get('Authorization')).toBe(expectedBasic)
	expect(await transformed.text()).toBe('grant_type=client_credentials')
	for (const name of ['paypalClientId', 'paypalClientSecret']) {
		expect(resolveSpy).toHaveBeenCalledWith(
			expect.objectContaining({ name, scope: 'user' }),
		)
	}
	const schemePrefixed = await expand(tokenRequest(`basic ${placeholder}`))
	expect(schemePrefixed.headers.get('Authorization')).toBe(expectedBasic)

	mockPaypalSecrets({ paypalClientId: paypalHost })
	await expect(expand(tokenRequest(placeholder))).rejects.toSatisfy(
		(error: unknown) =>
			error instanceof McpCallerError &&
			error.message === 'Secret "paypalClientSecret" was not found.',
	)

	const blockedCases: Array<[string, Record<string, Array<string>>]> = [
		['paypalClientId', { paypalClientId: [], paypalClientSecret: paypalHost }],
		[
			'paypalClientSecret',
			{ paypalClientId: paypalHost, paypalClientSecret: [] },
		],
	]
	for (const [blockedSecretName, hostsByName] of blockedCases) {
		mockPaypalSecrets(hostsByName)
		const approvals = await readHostApprovals(expand(tokenRequest(placeholder)))
		expect(approvals?.entries[0]).toMatchObject({
			secretName: blockedSecretName,
			host: 'api-m.paypal.com',
		})
	}
})

test('fetch gateway resolves path-only URLs against baseUrl and sets a default User-Agent', async () => {
	expect((await expand(createPathOnlyRequest('/'))).url).toBe(
		'https://example.com/',
	)
	expect((await expand(createPathOnlyRequest('/core/log'))).url).toBe(
		'https://example.com/core/log',
	)

	// GitHub rejects UA-less requests with an opaque 403, and workerd sends
	// no UA by default. Pin presence/override, not the default string value.
	const github = (headers?: HeadersInit) =>
		expand(new Request('https://api.github.com/user', { headers }))
	expect((await github()).headers.get('user-agent')).toBeTruthy()
	expect(
		(await github({ 'User-Agent': 'my-package/2.0' })).headers.get(
			'user-agent',
		),
	).toBe('my-package/2.0')
	expect(
		(await github({ 'x-kody-secret-resolution': 'off' })).headers.get(
			'user-agent',
		),
	).toBeTruthy()
})

test('gateway fetch records outbound_fetch usage metering', async () => {
	const recordUsageSpy = vi
		.spyOn(usageModule, 'recordUsage')
		.mockResolvedValue(undefined)
	const fetchStub = vi.fn()
	const waitUntil = vi.fn()
	const gatewayFetch = (
		url: string,
		extra: Partial<Parameters<typeof executeGatewayFetch>[0]> = {},
	) =>
		executeGatewayFetch({
			env,
			props,
			request: url.startsWith('/')
				? createPathOnlyRequest(url)
				: new Request(url),
			globalFetch: fetchStub,
			...extra,
		})
	const takeUsage = () => {
		expect(recordUsageSpy).toHaveBeenCalledTimes(1)
		const usage = recordUsageSpy.mock.calls[0]
		recordUsageSpy.mockClear()
		fetchStub.mockClear()
		waitUntil.mockClear()
		return usage
	}

	fetchStub.mockResolvedValue(
		new Response('ok', { status: 200, headers: { 'content-length': '1234' } }),
	)
	const successResponse = await gatewayFetch('https://api.example.com/data', {
		waitUntil,
	})
	expect(successResponse.status).toBe(200)
	expect(fetchStub).toHaveBeenCalledTimes(1)
	// waitUntil: usage metering only
	expect(waitUntil).toHaveBeenCalledTimes(1)
	expect(takeUsage()).toEqual([
		env,
		{
			userId: ownerIdFromStored('user-123'),
			actorUserId: 'user-123',
			automationSource: '',
			connectionKey: 'session:user-123:',
			eventType: 'outbound_fetch',
			entityId: 'api.example.com',
			durationMs: expect.any(Number),
			bytes: 1234,
			outcome: 'success',
		},
	])

	const expectMeteredWithoutBytes = (entityId: string, outcome: string) => {
		const usage = takeUsage()
		expect(usage).toEqual([
			env,
			expect.objectContaining({
				userId: ownerIdFromStored('user-123'),
				eventType: 'outbound_fetch',
				entityId,
				outcome,
			}),
		])
		expect(usage?.[1]?.bytes).toBeUndefined()
	}

	fetchStub.mockResolvedValue(new Response('upstream error', { status: 502 }))
	const upstreamErrorResponse = await gatewayFetch(
		'https://api.example.com/upstream-error',
		{ waitUntil },
	)
	expect(upstreamErrorResponse.status).toBe(502)
	expectMeteredWithoutBytes('api.example.com', 'success')

	fetchStub.mockResolvedValue(new Response('ok', { status: 200 }))
	await gatewayFetch('https://api.example.com/no-length')
	expectMeteredWithoutBytes('api.example.com', 'success')

	fetchStub.mockRejectedValue(new Error('network failed'))
	await expect(gatewayFetch('https://api.example.com/fail')).rejects.toThrow(
		'network failed',
	)
	expectMeteredWithoutBytes('api.example.com', 'error')

	await expect(
		gatewayFetch('https://original.example.com/api', {
			props: { ...props, baseUrl: '' },
		}),
	).rejects.toThrow('Fetch gateway requires a non-empty baseUrl in props.')
	expect(fetchStub).not.toHaveBeenCalled()
	expectMeteredWithoutBytes('original.example.com', 'error')

	// Error path with waitUntil available: metering is deferred, never blocks.
	fetchStub.mockRejectedValue(new Error('network failed with waitUntil'))
	await expect(
		gatewayFetch('https://api.example.com/fail-deferred', { waitUntil }),
	).rejects.toThrow('network failed with waitUntil')
	// waitUntil: usage metering only
	expect(waitUntil).toHaveBeenCalledTimes(1)
	expect(takeUsage()?.[1]).toMatchObject({
		entityId: 'api.example.com',
		outcome: 'error',
	})

	fetchStub.mockResolvedValue(new Response('ok'))
	await gatewayFetch('https://api.example.com/anonymous', {
		props: { ...props, userId: null },
	})
	expect(recordUsageSpy).not.toHaveBeenCalled()
	fetchStub.mockClear()

	// Path-only URLs meter the baseUrl host they resolve against.
	fetchStub.mockImplementation(async () => new Response('ok'))
	await gatewayFetch('/api/status')
	expect(fetchStub.mock.calls[0]?.[0]?.url).toBe(
		'https://example.com/api/status',
	)
	expect(takeUsage()?.[1]).toMatchObject({
		entityId: 'example.com',
		outcome: 'success',
	})
	// A filled URL path meters only the host, never the secret.
	fetchStub.mockClear()
	vi.spyOn(secretService, 'resolveSecret').mockResolvedValue(
		userSecret('tok_path_value', ['example.com']),
	)
	await gatewayFetch('/bot%7B%7Bsecret:token%7D%7D/getMe')
	expect(fetchStub.mock.calls[0]?.[0]?.url).toBe(
		'https://example.com/bottok_path_value/getMe',
	)
	const pathUsage = takeUsage()?.[1]
	expect(pathUsage).toMatchObject({
		entityId: 'example.com',
		outcome: 'success',
	})
	expect(JSON.stringify(pathUsage)).not.toContain('tok_path_value')
})

test('leak: a substituted secret the remote echoes back is redacted before the caller sees it', async () => {
	vi.spyOn(usageModule, 'recordUsage').mockResolvedValue(undefined)
	const values: Record<string, string> = {
		apiToken: 'sk_live_echo_123456',
		clientId: 'client-id',
		clientSecret: 'client-secret',
	}
	vi.spyOn(secretService, 'resolveSecret').mockImplementation(
		async ({ name }: { name: string }) =>
			userSecret(values[name]!, ['api.example.com']),
	)
	const encoder = new TextEncoder()
	const echoFetch = vi.fn(async (request: Request) => {
		const authorization = request.headers.get('authorization') ?? ''
		const credential = authorization.split(' ').at(-1)
		const echoed = encoder.encode(
			`{"you_sent":"${authorization}","credential":"${credential}"}`,
		)
		const split = Math.floor(echoed.length / 2)
		return new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(echoed.subarray(0, split))
					controller.enqueue(echoed.subarray(split))
					controller.close()
				},
			}),
			{
				headers: {
					'content-length': String(echoed.length),
					'x-echo': authorization,
				},
			},
		)
	})
	const fetchWith = (authorization: string) =>
		executeGatewayFetch({
			env,
			props,
			request: new Request('https://api.example.com/echo', {
				headers: { Authorization: authorization },
			}),
			globalFetch: echoFetch as unknown as typeof fetch,
		})

	const bearer = await fetchWith('Bearer {{secret:apiToken}}')
	expect(echoFetch.mock.calls[0]?.[0]?.headers.get('authorization')).toBe(
		'Bearer sk_live_echo_123456',
	)
	expect(bearer.headers.get('x-echo')).toBe('Bearer [REDACTED SECRET]')
	expect(bearer.headers.get('content-length')).toBeNull()
	expect(await bearer.text()).toBe(
		'{"you_sent":"Bearer [REDACTED SECRET]","credential":"[REDACTED SECRET]"}',
	)

	const basic = await fetchWith(
		buildBasicAuthSecretPlaceholder({
			usernameSecret: 'clientId',
			passwordSecret: 'clientSecret',
		}),
	)
	const basicBody = await basic.text()
	expect(basicBody).toBe(
		'{"you_sent":"[REDACTED SECRET]","credential":"[REDACTED SECRET]"}',
	)
	expect(basicBody).not.toContain(btoa('client-id:client-secret'))

	// Without a substituted secret the response passes through untouched.
	const plainResponse = new Response('sk_live_echo_123456')
	const plain = await executeGatewayFetch({
		env,
		props,
		request: new Request('https://api.example.com/echo'),
		globalFetch: (async () => plainResponse) as unknown as typeof fetch,
	})
	expect(plain).toBe(plainResponse)
})

test('leak: a secret filled into the body or URL is redacted from echoes in every encoding and from fetch errors', async () => {
	vi.spyOn(usageModule, 'recordUsage').mockResolvedValue(undefined)
	const secret = 'app pass/"word"&1'
	vi.spyOn(secretService, 'resolveSecret').mockResolvedValue(
		userSecret(secret, ['api.example.com']),
	)
	const sentBodies: Array<string> = []
	const echoFetch = vi.fn(async (request: Request) => {
		const body = await request.text()
		sentBodies.push(body)
		return new Response(`url=${request.url}\nbody=${body}`, {
			headers: { 'x-echo-url': request.url, 'x-echo-body': body },
		})
	})
	const send = (request: Request) =>
		executeGatewayFetch({
			env,
			props,
			request,
			globalFetch: echoFetch as unknown as typeof fetch,
		})

	const json = await send(
		new Request('https://api.example.com/session', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ password: '{{secret:appPassword}}' }),
		}),
	)
	expect(JSON.parse(sentBodies[0]!)).toEqual({ password: secret })
	expect(json.headers.get('x-echo-body')).toBe(
		'{"password":"[REDACTED SECRET]"}',
	)
	expect(await json.text()).toBe(
		'url=https://api.example.com/session\nbody={"password":"[REDACTED SECRET]"}',
	)

	const form = await send(
		new Request('https://api.example.com/token', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: 'password={{secret:appPassword}}',
		}),
	)
	const formEcho = await form.text()
	expect(formEcho).toBe(
		'url=https://api.example.com/token\nbody=password=[REDACTED SECRET]',
	)

	const query = await send(
		new Request('https://api.example.com/q?key={{secret:appPassword}}'),
	)
	expect(query.headers.get('x-echo-url')).toBe(
		'https://api.example.com/q?key=[REDACTED SECRET]',
	)
	expect(await query.text()).not.toContain('app')

	const failing = executeGatewayFetch({
		env,
		props,
		request: new Request(
			'https://api.example.com/q?key={{secret:appPassword}}',
		),
		globalFetch: (async (request: Request) => {
			throw new TypeError(`fetch failed for ${request.url}`)
		}) as unknown as typeof fetch,
	})
	const error = await failing.catch((caught: unknown) => caught)
	expect(error).toBeInstanceOf(Error)
	expect((error as Error).name).toBe('TypeError')
	expect((error as Error).message).toBe(
		'fetch failed for https://api.example.com/q?key=[REDACTED SECRET]',
	)
})

test('fetch gateway aborts hung outbound fetches via timeoutMs or outboundFetchTimeoutMs props', async () => {
	const createHungFetch = () =>
		vi.fn(
			(request: Request) =>
				new Promise<Response>((_resolve, reject) => {
					request.signal.addEventListener(
						'abort',
						() => {
							reject(
								request.signal.reason ??
									new DOMException('The operation was aborted.', 'AbortError'),
							)
						},
						{ once: true },
					)
				}),
		)
	const isAbortOrTimeout = (error: unknown) => {
		const name =
			error && typeof error === 'object' && 'name' in error
				? String(error.name)
				: ''
		return name === 'TimeoutError' || name === 'AbortError'
	}

	for (const [extra, maxElapsedMs] of [
		[{ timeoutMs: 40 }, 500],
		[{ props: { ...props, outboundFetchTimeoutMs: 40 } }, Infinity],
	] as const) {
		const hungFetch = createHungFetch()
		const startedAtMs = Date.now()
		await expect(
			executeGatewayFetch({
				env,
				props,
				request: new Request('https://example.com/slow'),
				globalFetch: hungFetch as unknown as typeof fetch,
				...extra,
			}),
		).rejects.toSatisfy(isAbortOrTimeout)
		expect(Date.now() - startedAtMs).toBeLessThan(maxElapsedMs)
		expect(hungFetch).toHaveBeenCalledTimes(1)
		expect(hungFetch.mock.calls[0]?.[0]?.signal.aborted).toBe(true)
	}
})

test('fetch gateway provider placeholders: normalize mixed case, deny wrong host and non-HTTPS without user secrets', async () => {
	const providerRef = 'i/cccccccc-cccc-4ccc-8ccc-cccccccccccc/password'
	const providerRequest = (url: string, placeholder: string) =>
		new Request(url, { headers: { Authorization: `Bearer ${placeholder}` } })
	const canonical = `{{secret/1password:${providerRef}}}`
	vi.spyOn(providerService, 'getSecretProviderBinding').mockResolvedValue(null)
	const resolveSpy = vi
		.spyOn(providerService, 'resolveProviderSecret')
		.mockResolvedValue({
			provider: '1password',
			ref: providerRef,
			canonicalRef: providerRef,
			value: 'vault-password',
			hosts: ['app.example.com'],
		})
	const userSecretSpy = vi.spyOn(secretService, 'resolveSecret')

	const allowed = await expand(
		providerRequest('https://app.example.com/login', canonical),
	)
	expect(allowed.headers.get('Authorization')).toBe('Bearer vault-password')
	expect(resolveSpy).toHaveBeenCalledTimes(1)
	expect(resolveSpy).toHaveBeenCalledWith(
		expect.objectContaining({ request: props.request }),
	)

	await expect(
		expand(providerRequest('https://evil.example.com/login', canonical)),
	).rejects.toThrow('not allowed for host "evil.example.com"')
	await expect(
		expand(providerRequest('http://app.example.com/login', canonical)),
	).rejects.toThrow(/HTTPS/)
	expect(userSecretSpy).not.toHaveBeenCalled()

	// The original mixed-case placeholder is replaced after normalize.
	const mixedCase = await expand(
		providerRequest(
			'https://app.example.com/login',
			`{{secret/1Password: ${providerRef} }}`,
		),
	)
	expect(mixedCase.headers.get('Authorization')).toBe('Bearer vault-password')
	expect(resolveSpy).toHaveBeenLastCalledWith(
		expect.objectContaining({ provider: '1Password', ref: providerRef }),
	)
})

test('executeGatewayFetch rejects when allowOutboundFetch is false', async () => {
	const recordUsageSpy = vi
		.spyOn(usageModule, 'recordUsage')
		.mockResolvedValue(undefined)
	const globalFetch = vi.fn(async () => new Response('ok'))
	await expect(
		executeGatewayFetch({
			env,
			props: {
				baseUrl: 'https://kody.example',
				userId: ownerIdFromStored('user-123'),
				email: 'user@example.com',
				request: null,
				storageContext: null,
				allowOutboundFetch: false,
			},
			request: new Request('https://example.com'),
			globalFetch: globalFetch as unknown as typeof fetch,
		}),
	).rejects.toThrow('Outbound fetch is not available in retriever runs.')
	expect(globalFetch).not.toHaveBeenCalled()
	expect(recordUsageSpy).not.toHaveBeenCalled()
})
