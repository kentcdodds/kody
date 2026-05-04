declare module 'kody:runtime' {
	type AccessNetworksUnleashedAjaxAction = 'getstat' | 'setconf' | 'docmd'

	type AccessNetworksUnleashedRequestArgs = {
		action: AccessNetworksUnleashedAjaxAction
		comp: string
		xmlBody: string
		updater?: string
		allowInsecureTls?: boolean
		acknowledgeHighRisk: true
		reason: string
		confirmation: string
	}

	type AccessNetworksUnleashedRequestResult = {
		structuredContent?: {
			action: AccessNetworksUnleashedAjaxAction
			comp: string
			updater: string
			xml: string
			parsed: unknown
		}
	}

	type Codemode = {
		home_access_networks_unleashed_request(
			args: AccessNetworksUnleashedRequestArgs,
		): Promise<AccessNetworksUnleashedRequestResult>
		[capability: string]: (args: Record<string, unknown>) => Promise<unknown>
	}

	export const codemode: Codemode
}
