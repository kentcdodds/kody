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

function fakeMcp(options: {
	initializedStatus?: number
	onToolCall: (body: {
		method?: string
		params?: { name?: string; arguments?: { code?: string } }
	}) => Response
}) {
	const requests: Array<Request> = []
	const callMcp = async (request: Request) => {
		requests.push(request)
		const body = (await request.clone().json()) as Parameters<
			typeof options.onToolCall
		>[0]
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
			const status = options.initializedStatus ?? 202
			return new Response(status === 202 ? null : 'Unauthorized', { status })
		}
		return options.onToolCall(body)
	}
	return { requests, callMcp }
}

function probe(callMcp: (request: Request) => Promise<Response>) {
	return runAuthenticatedMcpExecuteHealthProbe({
		token: 'canary-token',
		mcpOrigin: 'https://kody.codes',
		callMcp,
	})
}

test('authenticated probe uses the legacy MCP execute path and rejects caller errors', async () => {
	const ok = fakeMcp({
		onToolCall: (body) => {
			expect(body.method).toBe('tools/call')
			expect(body.params?.name).toBe('execute')
			expect(body.params?.arguments?.code).toBe('export default async () => 1')
			return jsonRpcResult({ structuredContent: { result: 1 }, isError: false })
		},
	})
	await expect(probe(ok.callMcp)).resolves.toEqual({
		result: 1,
		scope: 'authenticated-mcp-execute',
		proves: 'platform-mcp-execute',
	})
	const { requests } = ok
	expect(requests).toHaveLength(3)
	expect(new URL(requests[0]?.url ?? '').pathname).toBe('/mcp')
	expect(requests[0]?.headers.get('Authorization')).toBe('Bearer canary-token')
	const initializeBody = (await requests[0]?.clone().json()) as {
		params: { clientInfo: { name: string }; protocolVersion: string }
	}
	expect(initializeBody.params.protocolVersion).toBe('2025-06-18')
	expect(initializeBody.params.clientInfo.name).toBe('kody-execute-health')
	expect(requests[2]?.headers.get('mcp-session-id')).toBe('session-1')

	const toolError = fakeMcp({
		onToolCall: () =>
			jsonRpcResult({
				structuredContent: { result: 1, error: 'boom' },
				isError: true,
			}),
	})
	await expect(probe(toolError.callMcp)).rejects.toBeInstanceOf(
		MaintenanceFailureError,
	)
	const initializedRejected = fakeMcp({
		initializedStatus: 401,
		onToolCall: () =>
			jsonRpcResult({ structuredContent: { result: 1 }, isError: false }),
	})
	await expect(probe(initializedRejected.callMcp)).rejects.toBeInstanceOf(
		MaintenanceFailureError,
	)
})

test('maintenance route never runs execute on GET and public callers cannot trigger it', async () => {
	const fetchMcp = vi.fn(async () => new Response('should-not-run'))
	const env = {
		STATUS_INCIDENT_EVENT_SECRET: 'status-secret',
		MCP_EXECUTE_HEALTH_CANARY_ACCESS_TOKEN: 'canary-token',
		APP_BASE_URL: 'https://kody.codes',
	}
	const url = 'https://kody.codes/__maintenance/mcp-execute-health'
	const cases: Array<[RequestInit, Partial<typeof env>, number]> = [
		[{}, env, 405],
		[{ method: 'POST' }, env, 401],
		[
			{ method: 'POST', headers: { Authorization: 'Bearer status-secret' } },
			{ APP_BASE_URL: 'https://kody.codes' },
			503,
		],
	]
	const statuses = []
	for (const [init, caseEnv] of cases) {
		const response = await handleExecuteHealthProbeRequest(
			new Request(url, init),
			caseEnv,
			{} as ExecutionContext,
			fetchMcp,
		)
		statuses.push(response.status)
	}
	expect(statuses).toEqual(cases.map(([, , status]) => status))
	expect(fetchMcp).not.toHaveBeenCalled()
})
