export type PackageTestHints = {
	app?: string
	subscriptions?: Array<{
		topic: string
		snippet: string
	}>
}

export function buildPackageTestHints(input: {
	kodyId: string
	hasApp: boolean
	subscriptionTopics: ReadonlyArray<string>
}): PackageTestHints | undefined {
	const subscriptions = [...new Set(input.subscriptionTopics)]
		.sort((left, right) => left.localeCompare(right))
		.map((topic) => ({
			topic,
			snippet: `package_subscription_dispatch({ kody_id: ${JSON.stringify(input.kodyId)}, topic: ${JSON.stringify(topic)}, params: {} })`,
		}))
	if (!input.hasApp && subscriptions.length === 0) return undefined
	return {
		...(input.hasApp
			? {
					app: `package_app_fetch({ kody_id: ${JSON.stringify(input.kodyId)} })`,
				}
			: {}),
		...(subscriptions.length > 0 ? { subscriptions } : {}),
	}
}
