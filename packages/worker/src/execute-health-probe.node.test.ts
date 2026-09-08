import { expect, test, vi } from 'vitest'
import { MaintenanceFailureError } from './maintenance-handler.ts'
import {
	handleExecuteHealthProbeRequest,
	runAuthenticatedMcpExecuteHealthProbe,
} from './execute-health-probe.ts'

function jsonRpcResult(result: unknown, headers?: HeadersInit) {
	return new Response(JSON.stringify({ jsonrpc: '2.0', id: 2, result }), {
		status: 200,
		headers: {
			'Content-Type': 'application/json',
			...headers,
		},
	})
}

test('authenticated probe uses the legacy MCP execute path and rejects caller errors', async () => {
	const requests: Array<Request> = []
	const callMcp = async (request: Request) => {
		requests.push(request)
		const body = (await request.clone().json()) as {
			method?: string
			params?: { name?: string; arguments?: { code?: string } }
		}
		if (body.method === 'initialize') {
			return new Response(
				JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }),
				{
					status: 200,
					headers: {
						'Content-Type': 'application/json',
						'mcp-session-id': 'session-1',
					},
				},
			)
		}
		if (body.method === 'notifications/initialized') {
			return new Response(null, { status: 202 })
		}
		expect(body.method).toBe('tools/call')
		expect(body.params?.name).toBe('execute')
		expect(body.params?.arguments?.code).toBe('export default async () => 1')
		return jsonRpcResult({
			structuredContent: { result: 1 },
			isError: false,
		})
	}

	await expect(
		runAuthenticatedMcpExecuteHealthProbe({
			token: 'canary-token',
			mcpOrigin: 'https://kody.codes',
			callMcp,
		}),
	).resolves.toEqual({
		result: 1,
		scope: 'authenticated-mcp-execute',
		proves: 'platform-mcp-execute',
	})
	expect(requests).toHaveLength(3)
	expect(new URL(requests[0]?.url ?? '').pathname).toBe('/mcp')
	expect(requests[0]?.headers.get('Authorization')).toBe('Bearer canary-token')
	const initializeBody = (await requests[0]?.clone().json()) as {
		params: { clientInfo: { name: string }; protocolVersion: string }
	}
	expect(initializeBody.params.protocolVersion).toBe('2025-06-18')
	expect(initializeBody.params.clientInfo.name).toBe('kody-execute-health')
	expect(requests[2]?.headers.get('mcp-session-id')).toBe('session-1')

	await expect(
		runAuthenticatedMcpExecuteHealthProbe({
			token: 'canary-token',
			mcpOrigin: 'https://kody.codes',
			callMcp: async (request) => {
				const body = (await request.clone().json()) as { method?: string }
				if (body.method === 'initialize') {
					return new Response(
						JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }),
						{
							headers: { 'mcp-session-id': 'session-1' },
						},
					)
				}
				if (body.method === 'notifications/initialized') {
					return new Response(null, { status: 202 })
				}
				return jsonRpcResult({
					structuredContent: { result: 1, error: 'boom' },
					isError: true,
				})
			},
		}),
	).rejects.toBeInstanceOf(MaintenanceFailureError)

	await expect(
		runAuthenticatedMcpExecuteHealthProbe({
			token: 'canary-token',
			mcpOrigin: 'https://kody.codes',
			callMcp: async (request) => {
				const body = (await request.clone().json()) as { method?: string }
				if (body.method === 'initialize') {
					return new Response(
						JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }),
						{
							headers: { 'mcp-session-id': 'session-1' },
						},
					)
				}
				if (body.method === 'notifications/initialized') {
					return new Response('Unauthorized', { status: 401 })
				}
				return jsonRpcResult({
					structuredContent: { result: 1 },
					isError: false,
				})
			},
		}),
	).rejects.toBeInstanceOf(MaintenanceFailureError)
})

test('maintenance route never runs execute on GET and public callers cannot trigger it', async () => {
	const fetchMcp = vi.fn(async () => new Response('should-not-run'))
	const env = {
		STATUS_INCIDENT_EVENT_SECRET: 'status-secret',
		MCP_EXECUTE_HEALTH_CANARY_ACCESS_TOKEN: 'canary-token',
		APP_BASE_URL: 'https://kody.codes',
	}
	const ctx = {} as ExecutionContext

	const getResponse = await handleExecuteHealthProbeRequest(
		new Request('https://kody.codes/__maintenance/mcp-execute-health'),
		env,
		ctx,
		fetchMcp,
	)
	expect(getResponse.status).toBe(405)
	expect(fetchMcp).not.toHaveBeenCalled()

	const unauthorized = await handleExecuteHealthProbeRequest(
		new Request('https://kody.codes/__maintenance/mcp-execute-health', {
			method: 'POST',
		}),
		env,
		ctx,
		fetchMcp,
	)
	expect(unauthorized.status).toBe(401)
	expect(fetchMcp).not.toHaveBeenCalled()

	const unconfigured = await handleExecuteHealthProbeRequest(
		new Request('https://kody.codes/__maintenance/mcp-execute-health', {
			method: 'POST',
			headers: { Authorization: 'Bearer status-secret' },
		}),
		{ APP_BASE_URL: 'https://kody.codes' },
		ctx,
		fetchMcp,
	)
	expect(unconfigured.status).toBe(503)
	expect(fetchMcp).not.toHaveBeenCalled()
})
