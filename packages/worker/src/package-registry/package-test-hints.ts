export type PackageTestHints = {
	app?: string
	subscriptions?: Array<{
		topic: string
		snippet: string
	}>
}

export function buildPackageTestHints(input: {
	packageId: string
	hasApp: boolean
	subscriptionTopics: ReadonlyArray<string>
}): PackageTestHints | undefined {
	const packageIdentity = `package_id: ${JSON.stringify(input.packageId)}`
	const subscriptions = [...new Set(input.subscriptionTopics)]
		.sort((left, right) => left.localeCompare(right))
		.map((topic) => ({
			topic,
			snippet: `packageSubscriptionDispatch({ ${packageIdentity}, topic: ${JSON.stringify(topic)}, params: {} })`,
		}))
	if (!input.hasApp && subscriptions.length === 0) return undefined
	return {
		...(input.hasApp
			? {
					app: `packageAppFetch({ ${packageIdentity} })`,
				}
			: {}),
		...(subscriptions.length > 0 ? { subscriptions } : {}),
	}
}
