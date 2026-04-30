export function normalizePackageSubscriptionTopic(topic: string) {
	const trimmed = topic.trim()
	if (!trimmed) {
		throw new Error('Package subscription topic must not be empty.')
	}
	return trimmed
}

export function buildPackageSubscriptionArtifactName(topic: string) {
	return `subscription:${normalizePackageSubscriptionTopic(topic)}`
}
