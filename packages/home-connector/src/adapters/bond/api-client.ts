function buildBondBaseUrl(host: string, port: number) {
	const trimmed = host.replace(/\.$/, '')
	const safePort = Number.isFinite(port) && port > 0 ? port : 80
	if (safePort === 80) {
		return `http://${trimmed}`
	}
	return `http://${trimmed}:${String(safePort)}`
}

export async function bondRequestJson(input: {
	baseUrl: string
	path: string
	method?: string
	token?: string | null
	body?: unknown
}): Promise<unknown> {
	const method = input.method ?? 'GET'
	const headers: Record<string, string> = {
		Accept: 'application/json',
	}
	if (input.token) {
		headers['BOND-Token'] = input.token
	}
	if (input.body !== undefined && method !== 'GET' && method !== 'HEAD') {
		headers['Content-Type'] = 'application/json'
	}
	const response = await fetch(`${input.baseUrl}${input.path}`, {
		method,
		headers,
		body:
			input.body === undefined || method === 'GET' || method === 'HEAD'
				? undefined
				: JSON.stringify(input.body),
	})
	const text = await response.text()
	let json: unknown = null
	if (text) {
		try {
			json = JSON.parse(text) as unknown
		} catch {
			json = { _raw: text }
		}
	}
	if (!response.ok) {
		const message =
			typeof json === 'object' &&
			json &&
			'message' in json &&
			typeof (json as { message?: unknown }).message === 'string'
				? (json as { message: string }).message
				: text.slice(0, 200)
		throw new Error(
			`Bond HTTP ${String(response.status)} for ${input.path}: ${message}`,
		)
	}
	return json
}

export async function bondGetSysVersion(input: { baseUrl: string }) {
	const json = await bondRequestJson({
		baseUrl: input.baseUrl,
		path: '/v2/sys/version',
		method: 'GET',
	})
	return json as Record<string, unknown>
}

export async function bondGetTokenStatus(input: {
	baseUrl: string
	token?: string | null
}) {
	const json = await bondRequestJson({
		baseUrl: input.baseUrl,
		path: '/v2/token',
		method: 'GET',
		token: input.token,
	})
	return json as Record<string, unknown>
}

export async function bondListDeviceIds(input: {
	baseUrl: string
	token: string
}) {
	const json = (await bondRequestJson({
		baseUrl: input.baseUrl,
		path: '/v2/devices',
		method: 'GET',
		token: input.token,
	})) as Record<string, unknown>
	return Object.keys(json).filter((key) => !key.startsWith('_'))
}

export async function bondGetDevice(input: {
	baseUrl: string
	token: string
	deviceId: string
}) {
	const json = (await bondRequestJson({
		baseUrl: input.baseUrl,
		path: `/v2/devices/${encodeURIComponent(input.deviceId)}`,
		method: 'GET',
		token: input.token,
	})) as Record<string, unknown>
	return json
}

export async function bondGetDeviceState(input: {
	baseUrl: string
	token: string
	deviceId: string
}) {
	const json = (await bondRequestJson({
		baseUrl: input.baseUrl,
		path: `/v2/devices/${encodeURIComponent(input.deviceId)}/state`,
		method: 'GET',
		token: input.token,
	})) as Record<string, unknown>
	return json
}

export async function bondInvokeDeviceAction(input: {
	baseUrl: string
	token: string
	deviceId: string
	action: string
	argument?: number | string | boolean | null
}) {
	const body =
		input.argument === undefined || input.argument === null
			? {}
			: { argument: input.argument }
	return await bondRequestJson({
		baseUrl: input.baseUrl,
		path: `/v2/devices/${encodeURIComponent(input.deviceId)}/actions/${encodeURIComponent(input.action)}`,
		method: 'PUT',
		token: input.token,
		body,
	})
}

export async function bondListGroupIds(input: {
	baseUrl: string
	token: string
}) {
	const json = (await bondRequestJson({
		baseUrl: input.baseUrl,
		path: '/v2/groups',
		method: 'GET',
		token: input.token,
	})) as Record<string, unknown>
	return Object.keys(json).filter((key) => !key.startsWith('_'))
}

export async function bondGetGroup(input: {
	baseUrl: string
	token: string
	groupId: string
}) {
	return (await bondRequestJson({
		baseUrl: input.baseUrl,
		path: `/v2/groups/${encodeURIComponent(input.groupId)}`,
		method: 'GET',
		token: input.token,
	})) as Record<string, unknown>
}

export async function bondGetGroupState(input: {
	baseUrl: string
	token: string
	groupId: string
}) {
	return (await bondRequestJson({
		baseUrl: input.baseUrl,
		path: `/v2/groups/${encodeURIComponent(input.groupId)}/state`,
		method: 'GET',
		token: input.token,
	})) as Record<string, unknown>
}

export async function bondInvokeGroupAction(input: {
	baseUrl: string
	token: string
	groupId: string
	action: string
	argument?: number | string | boolean | null
}) {
	const body =
		input.argument === undefined || input.argument === null
			? {}
			: { argument: input.argument }
	return await bondRequestJson({
		baseUrl: input.baseUrl,
		path: `/v2/groups/${encodeURIComponent(input.groupId)}/actions/${encodeURIComponent(input.action)}`,
		method: 'PUT',
		token: input.token,
		body,
	})
}

export { buildBondBaseUrl }
