import { expect, test } from 'vitest'
import {
	buildMaintenanceExpression,
	buildMaintenanceRedirectRule,
	cloudflareApiBaseUrl,
	defaultMaintenanceTarget,
	defaultMaintenanceZone,
	maintenanceRuleMarker,
	parseArgs,
	requiredTokenScopesMessage,
	runMaintenanceMode,
} from './maintenance-mode.ts'

const zoneId = 'zone-kody'
const rulesetId = 'ruleset-redirects'
const ruleId = 'rule-maintenance'

function jsonResponse(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	})
}

function envelope<T>(result: T, status = 200) {
	return jsonResponse({ success: true, result, errors: [] }, status)
}

function zoneLookup() {
	return envelope([{ id: zoneId, name: defaultMaintenanceZone }])
}

function redirectRule(enabled: boolean) {
	return {
		id: ruleId,
		ref: maintenanceRuleMarker,
		description: maintenanceRuleMarker,
		enabled,
		expression: buildMaintenanceExpression(defaultMaintenanceZone),
		action: 'redirect',
		action_parameters: {
			from_value: {
				target_url: { value: defaultMaintenanceTarget },
				status_code: 302,
				preserve_query_string: false,
			},
		},
	}
}

function entrypoint(rules: Array<ReturnType<typeof redirectRule>>) {
	return envelope({
		id: rulesetId,
		name: 'Redirect rules ruleset',
		kind: 'zone',
		phase: 'http_request_dynamic_redirect',
		rules,
	})
}

function mockFetch(handler: (url: string, init?: RequestInit) => Response) {
	const calls: Array<{ method: string; url: string; body: unknown }> = []
	const fetchImpl: typeof fetch = async (input, init) => {
		const url = String(input)
		const method = init?.method ?? 'GET'
		const body = init?.body ? JSON.parse(String(init.body)) : undefined
		calls.push({ method, url, body })
		return handler(url, init)
	}
	return { fetchImpl, calls }
}

test('dry-run without a token prints command-specific Rulesets API calls', async () => {
	const lines: Array<string> = []
	const on = await runMaintenanceMode(parseArgs(['on', '--dry-run']), {
		env: {},
		log: (line) => lines.push(line),
	})
	expect(
		on.requests.map((request) => `${request.method} ${request.url}`),
	).toEqual([
		`GET ${cloudflareApiBaseUrl}/zones?name=${defaultMaintenanceZone}&status=active`,
		`GET ${cloudflareApiBaseUrl}/zones/{zone_id}/rulesets/phases/http_request_dynamic_redirect/entrypoint`,
		`POST ${cloudflareApiBaseUrl}/zones/{zone_id}/rulesets`,
	])
	expect(on.requests[2]?.body).toMatchObject({
		phase: 'http_request_dynamic_redirect',
		rules: [{ description: maintenanceRuleMarker, enabled: true }],
	})

	const off = await runMaintenanceMode(parseArgs(['off', '--dry-run']), {
		env: {},
		log: () => {},
	})
	expect(off.requests.at(-1)).toMatchObject({
		method: 'PATCH',
		url: `${cloudflareApiBaseUrl}/zones/{zone_id}/rulesets/{ruleset_id}/rules/{rule_id}`,
		body: { enabled: false },
	})

	const status = await runMaintenanceMode(parseArgs(['status', '--dry-run']), {
		env: {},
		log: () => {},
	})
	expect(status.requests.every((request) => request.method === 'GET')).toBe(
		true,
	)
	expect(lines.join('\n')).toContain('POST')
})

test('parseArgs reads command, zone, target, dry-run, and json', () => {
	expect(parseArgs(['status'])).toEqual({
		command: 'status',
		zone: defaultMaintenanceZone,
		target: defaultMaintenanceTarget,
		dryRun: false,
		json: false,
	})
	expect(
		parseArgs([
			'on',
			'--zone',
			'example.com',
			'--target',
			'https://status.example.com/maintenance',
			'--dry-run',
			'--json',
		]),
	).toEqual({
		command: 'on',
		zone: 'example.com',
		target: 'https://status.example.com/maintenance',
		dryRun: true,
		json: true,
	})
	expect(() => parseArgs([])).toThrow(/Usage/)
	expect(() => parseArgs(['enable'])).toThrow(/Unknown command/)
	expect(() => parseArgs(['on', '--nope'])).toThrow(/Unknown flag/)
})

test('buildMaintenanceRedirectRule uses a static 302 to the status page', () => {
	expect(
		buildMaintenanceRedirectRule({
			zone: defaultMaintenanceZone,
			target: defaultMaintenanceTarget,
			enabled: true,
		}),
	).toEqual({
		ref: maintenanceRuleMarker,
		description: maintenanceRuleMarker,
		expression: `(http.host eq "${defaultMaintenanceZone}" and not starts_with(http.request.uri.path, "/__maintenance/") and http.request.uri.path ne "/health")`,
		action: 'redirect',
		enabled: true,
		action_parameters: {
			from_value: {
				target_url: { value: defaultMaintenanceTarget },
				status_code: 302,
				preserve_query_string: false,
			},
		},
	})
})

test('on creates the dynamic-redirect entrypoint when the zone has none', async () => {
	const { fetchImpl, calls } = mockFetch((url, init) => {
		if (url.includes('/zones?name=')) return zoneLookup()
		if (url.includes('/entrypoint')) {
			return jsonResponse(
				{ success: false, errors: [{ message: 'not found' }] },
				404,
			)
		}
		if ((init?.method ?? 'GET') === 'POST' && url.endsWith('/rulesets')) {
			return envelope({
				id: rulesetId,
				phase: 'http_request_dynamic_redirect',
				rules: [redirectRule(true)],
			})
		}
		throw new Error(`Unexpected ${init?.method ?? 'GET'} ${url}`)
	})

	const result = await runMaintenanceMode(parseArgs(['on']), {
		env: { CLOUDFLARE_API_TOKEN: 'token' },
		fetch: fetchImpl,
		log: () => {},
	})

	expect(result.exists).toBe(true)
	expect(result.enabled).toBe(true)
	expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
		`GET ${cloudflareApiBaseUrl}/zones?name=${defaultMaintenanceZone}&status=active`,
		`GET ${cloudflareApiBaseUrl}/zones/${zoneId}/rulesets/phases/http_request_dynamic_redirect/entrypoint`,
		`POST ${cloudflareApiBaseUrl}/zones/${zoneId}/rulesets`,
	])
	expect(calls[2]?.body).toEqual({
		name: 'Redirect rules ruleset',
		kind: 'zone',
		phase: 'http_request_dynamic_redirect',
		rules: [
			buildMaintenanceRedirectRule({
				zone: defaultMaintenanceZone,
				target: defaultMaintenanceTarget,
				enabled: true,
			}),
		],
	})
})

test('on adds the maintenance rule to an existing redirect ruleset', async () => {
	const { fetchImpl, calls } = mockFetch((url, init) => {
		if (url.includes('/zones?name=')) return zoneLookup()
		if (url.includes('/entrypoint')) return entrypoint([])
		if (
			(init?.method ?? 'GET') === 'POST' &&
			url.endsWith(`/${rulesetId}/rules`)
		) {
			return envelope({
				id: rulesetId,
				rules: [redirectRule(true)],
			})
		}
		throw new Error(`Unexpected ${init?.method ?? 'GET'} ${url}`)
	})

	const result = await runMaintenanceMode(parseArgs(['on']), {
		env: { CLOUDFLARE_API_TOKEN: 'token' },
		fetch: fetchImpl,
		log: () => {},
	})

	expect(result.enabled).toBe(true)
	expect(calls.at(-1)).toMatchObject({
		method: 'POST',
		url: `${cloudflareApiBaseUrl}/zones/${zoneId}/rulesets/${rulesetId}/rules`,
		body: buildMaintenanceRedirectRule({
			zone: defaultMaintenanceZone,
			target: defaultMaintenanceTarget,
			enabled: true,
		}),
	})
})

test('on enables an existing disabled maintenance rule', async () => {
	const { fetchImpl, calls } = mockFetch((url, init) => {
		if (url.includes('/zones?name=')) return zoneLookup()
		if (url.includes('/entrypoint')) return entrypoint([redirectRule(false)])
		if ((init?.method ?? 'GET') === 'PATCH' && url.endsWith(`/${ruleId}`)) {
			return envelope({
				id: rulesetId,
				rules: [redirectRule(true)],
			})
		}
		throw new Error(`Unexpected ${init?.method ?? 'GET'} ${url}`)
	})

	const result = await runMaintenanceMode(parseArgs(['on']), {
		env: { CLOUDFLARE_API_TOKEN: 'token' },
		fetch: fetchImpl,
		log: () => {},
	})

	expect(result.enabled).toBe(true)
	expect(calls.at(-1)).toMatchObject({
		method: 'PATCH',
		url: `${cloudflareApiBaseUrl}/zones/${zoneId}/rulesets/${rulesetId}/rules/${ruleId}`,
		body: { enabled: true, ref: maintenanceRuleMarker },
	})
})

test('on patches an enabled rule when the target differs', async () => {
	const staleTarget = 'https://status.kody.codes/old-maintenance'
	const { fetchImpl, calls } = mockFetch((url, init) => {
		if (url.includes('/zones?name=')) return zoneLookup()
		if (url.includes('/entrypoint')) {
			return envelope({
				id: rulesetId,
				name: 'Redirect rules ruleset',
				kind: 'zone',
				phase: 'http_request_dynamic_redirect',
				rules: [
					{
						...redirectRule(true),
						action_parameters: {
							from_value: {
								target_url: { value: staleTarget },
								status_code: 302,
								preserve_query_string: false,
							},
						},
					},
				],
			})
		}
		if ((init?.method ?? 'GET') === 'PATCH' && url.endsWith(`/${ruleId}`)) {
			return envelope({
				id: rulesetId,
				rules: [redirectRule(true)],
			})
		}
		throw new Error(`Unexpected ${init?.method ?? 'GET'} ${url}`)
	})

	const result = await runMaintenanceMode(parseArgs(['on']), {
		env: { CLOUDFLARE_API_TOKEN: 'token' },
		fetch: fetchImpl,
		log: () => {},
	})

	expect(result.target).toBe(defaultMaintenanceTarget)
	expect(calls.at(-1)).toMatchObject({
		method: 'PATCH',
		url: `${cloudflareApiBaseUrl}/zones/${zoneId}/rulesets/${rulesetId}/rules/${ruleId}`,
		body: {
			enabled: true,
			action_parameters: {
				from_value: { target_url: { value: defaultMaintenanceTarget } },
			},
		},
	})
})

test('off disables the existing rule and does not delete it', async () => {
	const { fetchImpl, calls } = mockFetch((url, init) => {
		if (url.includes('/zones?name=')) return zoneLookup()
		if (url.includes('/entrypoint')) return entrypoint([redirectRule(true)])
		if ((init?.method ?? 'GET') === 'PATCH' && url.endsWith(`/${ruleId}`)) {
			return envelope({
				id: rulesetId,
				rules: [redirectRule(false)],
			})
		}
		throw new Error(`Unexpected ${init?.method ?? 'GET'} ${url}`)
	})

	const result = await runMaintenanceMode(parseArgs(['off']), {
		env: { CLOUDFLARE_API_TOKEN: 'token' },
		fetch: fetchImpl,
		log: () => {},
	})

	expect(result.exists).toBe(true)
	expect(result.enabled).toBe(false)
	expect(calls.some((call) => call.method === 'DELETE')).toBe(false)
	expect(calls.at(-1)).toMatchObject({
		method: 'PATCH',
		url: `${cloudflareApiBaseUrl}/zones/${zoneId}/rulesets/${rulesetId}/rules/${ruleId}`,
		body: { enabled: false },
	})
})

test('status reports whether the rule exists and is enabled', async () => {
	const { fetchImpl } = mockFetch((url) => {
		if (url.includes('/zones?name=')) return zoneLookup()
		if (url.includes('/entrypoint')) return entrypoint([redirectRule(true)])
		throw new Error(`Unexpected GET ${url}`)
	})

	const result = await runMaintenanceMode(parseArgs(['status', '--json']), {
		env: { CLOUDFLARE_API_TOKEN: 'token' },
		fetch: fetchImpl,
		log: () => {},
	})

	expect(result).toMatchObject({
		command: 'status',
		exists: true,
		enabled: true,
		zone: defaultMaintenanceZone,
		target: defaultMaintenanceTarget,
		rulesetId,
		ruleId,
	})
})

test('403 responses name the required Zone:Read and Single Redirect scopes', async () => {
	const { fetchImpl } = mockFetch(() =>
		jsonResponse(
			{ success: false, errors: [{ message: 'Authentication error' }] },
			403,
		),
	)

	await expect(
		runMaintenanceMode(parseArgs(['status']), {
			env: { CLOUDFLARE_API_TOKEN: 'bad-token' },
			fetch: fetchImpl,
			log: () => {},
		}),
	).rejects.toThrow(requiredTokenScopesMessage)
})
