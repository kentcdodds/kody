import { orgSectionRestPath } from '#universal/org-section-hrefs.ts'

export function isAccountEmailLabel(value: string | null | undefined) {
	if (!value) return false
	const email = value.trim()
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

export function buildIntegrationAccountUrl(input: {
	baseUrl: string
	orgSlug: string
	integrationName: string
}) {
	return `${input.baseUrl}${orgSectionRestPath(
		input.orgSlug,
		'integrations',
		input.integrationName,
	)}`
}

export function buildIntegrationReconnectUrl(input: {
	baseUrl: string
	integrationName: string
	accountLabel?: string | null
}) {
	const reconnectUrl = `${input.baseUrl}/connect/oauth?provider=${encodeURIComponent(input.integrationName)}`
	const accountLabel = input.accountLabel?.trim() ?? ''
	if (!isAccountEmailLabel(accountLabel)) return reconnectUrl
	return `${reconnectUrl}&loginHint=${encodeURIComponent(accountLabel)}`
}
