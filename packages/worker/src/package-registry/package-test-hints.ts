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
	packageScope?: string
}): PackageTestHints | undefined {
	const packageIdentity = [
		`kody_id: ${JSON.stringify(input.kodyId)}`,
		...(input.packageScope
			? [`package_scope: ${JSON.stringify(input.packageScope)}`]
			: []),
	].join(', ')
	const subscriptions = [...new Set(input.subscriptionTopics)]
		.sort((left, right) => left.localeCompare(right))
		.map((topic) => ({
			topic,
			snippet: `package_subscription_dispatch({ ${packageIdentity}, topic: ${JSON.stringify(topic)}, params: {} })`,
		}))
	if (!input.hasApp && subscriptions.length === 0) return undefined
	return {
		...(input.hasApp
			? {
					app: `package_app_fetch({ ${packageIdentity} })`,
				}
			: {}),
		...(subscriptions.length > 0 ? { subscriptions } : {}),
	}
}
