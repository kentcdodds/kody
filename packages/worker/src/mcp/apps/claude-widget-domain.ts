import { toHex } from '@kody-internal/shared/hex.ts'

export async function computeClaudeWidgetDomain(mcpServerUrl: string) {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(mcpServerUrl),
	)
	return `${toHex(new Uint8Array(digest)).slice(0, 32)}.claudemcpcontent.com`
}
