type RecordedRequest = {
	action: 'getstat' | 'setconf' | 'docmd'
	comp: string
	xmlBody: string
	updater?: string
	reason: string
	confirmation: string
	acknowledgeHighRisk: true
	allowInsecureTls?: boolean
}

const calls: Array<RecordedRequest> = []
const responses: Array<{ xml: string; parsed?: unknown }> = []

function nextResponse() {
	return (
		responses.shift() ?? {
			xml: '<ajax-response><ok/></ajax-response>',
			parsed: { 'ajax-response': { ok: null } },
		}
	)
}

export const codemode = {
	async home_access_networks_unleashed_request(args: RecordedRequest) {
		calls.push(args)
		const next = nextResponse()
		return {
			structuredContent: {
				action: args.action,
				comp: args.comp,
				updater: args.updater ?? `${args.comp}.fake-updater`,
				xml: next.xml,
				parsed: next.parsed,
			},
		}
	},
	__resetUnleashedRuntime() {
		calls.length = 0
		responses.length = 0
	},
	__queueUnleashedResponse(response: { xml: string; parsed?: unknown }) {
		responses.push(response)
	},
	__getRecordedUnleashedRequests() {
		return calls
	},
}
