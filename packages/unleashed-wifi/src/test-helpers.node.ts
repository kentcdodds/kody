import { type Mock } from 'vitest'
import { codemode } from 'kody:runtime'

export type RecordedRequest = {
	action: 'getstat' | 'setconf' | 'docmd'
	comp: string
	xmlBody: string
	updater?: string
	reason: string
	confirmation: string
	acknowledgeHighRisk: true
	allowInsecureTls?: boolean
}

type RuntimeStub = {
	__resetUnleashedRuntime(): void
	__queueUnleashedResponse(response: { xml: string; parsed?: unknown }): void
	__getRecordedUnleashedRequests(): Array<RecordedRequest>
	home_access_networks_unleashed_request: Mock
}

function getRuntimeStub(): RuntimeStub {
	const stub = codemode as unknown as Partial<RuntimeStub>
	if (
		typeof stub.__resetUnleashedRuntime !== 'function' ||
		typeof stub.__queueUnleashedResponse !== 'function' ||
		typeof stub.__getRecordedUnleashedRequests !== 'function'
	) {
		throw new Error(
			'@kentcdodds/unleashed-wifi test helpers require the kody:runtime stub provided by vitest aliases.',
		)
	}
	return stub as RuntimeStub
}

export function resetUnleashedRuntime() {
	getRuntimeStub().__resetUnleashedRuntime()
}

export function queueUnleashedResponse(response: {
	xml: string
	parsed?: unknown
}) {
	getRuntimeStub().__queueUnleashedResponse(response)
}

export function getRecordedRequests(): Array<RecordedRequest> {
	return getRuntimeStub().__getRecordedUnleashedRequests()
}
