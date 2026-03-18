import { toHex } from './hex.ts'

type AuditEvent = {
	category: 'auth' | 'oauth'
	action: string
	result: 'success' | 'failure' | 'rate_limited'
	email?: string
	ip?: string
	clientId?: string
	path?: string
	reason?: string
}

async function hashIdentifier(value: string) {
	const data = new TextEncoder().encode(value.trim().toLowerCase())
	const digest = await crypto.subtle.digest('SHA-256', data)
	return toHex(new Uint8Array(digest))
}

export function getRequestIp(request: Request) {
	const forwarded = request.headers.get('x-forwarded-for')
	const forwardedIp = forwarded?.split(',')[0]?.trim()
	return (
		request.headers.get('CF-Connecting-IP') ??
		(forwardedIp && forwardedIp.length > 0 ? forwardedIp : null)
	)
}

export async function logAuditEvent(event: AuditEvent) {
	try {
		const [emailHash, ipHash] = await Promise.all([
			event.email ? hashIdentifier(event.email) : undefined,
			event.ip ? hashIdentifier(event.ip) : undefined,
		])
		const payload = {
			category: event.category,
			action: event.action,
			result: event.result,
			emailHash,
			ipHash,
			clientId: event.clientId,
			path: event.path,
			reason: event.reason,
			timestamp: new Date().toISOString(),
		}
		console.info('audit-event', JSON.stringify(payload))
	} catch (error) {
		console.warn('audit-event-failed', error)
	}
}
