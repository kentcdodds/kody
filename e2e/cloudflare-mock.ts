import { readE2eCloudflareMockState } from '../tools/e2e-cloudflare-mock-state.ts'

export const verificationEmailSubject =
	'Verify your email to finish setting up Kody'

export type MockEmailMessage = {
	id: string
	from_email: string
	to_json: string
	subject: string
	html: string
	text: string | null
}

type MockEmailListResponse = {
	count: number
	messages: Array<MockEmailMessage>
}

export function extractVerifyEmailPath(body: string) {
	const match = body.match(
		/https?:\/\/[^\s"'<>]+\/verify-email\?token=[a-f0-9]+(?:[&?][^\s"'<>]*)?/i,
	)
	if (!match?.[0]) return null
	const url = new URL(match[0].replaceAll('&amp;', '&'))
	return `${url.pathname}${url.search}`
}

export async function listE2eCloudflareMockMessages() {
	const mock = readE2eCloudflareMockState()
	const url = new URL('/__mocks/messages', mock.origin)
	url.searchParams.set('token', mock.token)
	url.searchParams.set('limit', '100')
	const response = await fetch(url)
	if (!response.ok) {
		throw new Error(
			`Cloudflare mock message list failed (${String(response.status)}).`,
		)
	}
	return (await response.json()) as MockEmailListResponse
}

export function findVerificationEmail(
	messages: Array<MockEmailMessage>,
	recipient: string,
) {
	const normalized = recipient.trim().toLowerCase()
	return (
		messages.find((message) => {
			if (message.subject !== verificationEmailSubject) return false
			return message.to_json.toLowerCase().includes(normalized)
		}) ?? null
	)
}
