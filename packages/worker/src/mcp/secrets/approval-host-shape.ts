import { parse } from 'tldts'
import { normalizeAllowedHosts } from './allowed-hosts.ts'

export type RejectedApprovalHostReason = 'malformed' | 'unknown_suffix'

export type RejectedApprovalHost = {
	host: string
	reason: RejectedApprovalHostReason
	message: string
}

export type ClassifiedApprovalHosts = {
	valid: Array<string>
	rejected: Array<RejectedApprovalHost>
}

/**
 * RFC 2606 / 6761 special-use suffixes that tldts does not mark ICANN.
 * `.localhost` is handled separately so `foo.localhost` stays valid.
 */
const specialUsePublicSuffixes = new Set(['example', 'invalid', 'test'])

const maxHostnameLength = 253

export function rejectedApprovalHostMessage(
	reason: RejectedApprovalHostReason,
): string {
	switch (reason) {
		case 'malformed':
			return "This host isn't valid — the link may have been truncated. Copy it again from Kody."
		case 'unknown_suffix':
			return "This host doesn't look complete (unknown public suffix). The approval link may have been truncated — copy it again."
		default: {
			const _exhaustive: never = reason
			return _exhaustive
		}
	}
}

export function classifyApprovalHosts(
	hosts: Array<string>,
	options?: { limit?: number },
): ClassifiedApprovalHosts {
	const normalized = normalizeAllowedHosts(hosts)
	const limited =
		options?.limit == null ? normalized : normalized.slice(0, options.limit)
	const valid: Array<string> = []
	const rejected: Array<RejectedApprovalHost> = []
	for (const host of limited) {
		const reason = classifyNormalizedApprovalHost(host)
		if (reason == null) {
			valid.push(host)
			continue
		}
		rejected.push({
			host,
			reason,
			message: rejectedApprovalHostMessage(reason),
		})
	}
	return { valid, rejected }
}

export function filterValidApprovalHosts(hosts: Array<string>) {
	return classifyApprovalHosts(hosts).valid
}

function classifyNormalizedApprovalHost(
	host: string,
): RejectedApprovalHostReason | null {
	if (host.length === 0 || host.length > maxHostnameLength) return 'malformed'
	if (containsForbiddenHostChars(host)) return 'malformed'
	if (host.startsWith('.') || host.endsWith('.') || host.includes('..')) {
		return 'malformed'
	}
	if (isIpAddress(host)) return null
	if (looksLikeInvalidIpv4(host)) return 'malformed'
	if (host === 'localhost' || host.endsWith('.localhost')) {
		return isDnsLabelList(host) ? null : 'malformed'
	}
	if (!host.includes('.')) return 'malformed'
	if (!isHostnameToken(host)) return 'malformed'

	const parsed = parse(host, { detectIp: false, validateHostname: true })
	if (parsed.hostname !== host) return 'malformed'
	if (parsed.isIcann === true || parsed.isPrivate === true) return null
	if (
		parsed.publicSuffix != null &&
		specialUsePublicSuffixes.has(parsed.publicSuffix)
	) {
		return null
	}
	return 'unknown_suffix'
}

function containsForbiddenHostChars(host: string) {
	return /[\s/?#@\\]/.test(host)
}

function isHostnameToken(host: string) {
	if (isDnsLabelList(host)) return true
	// IDN API hosts are uncommon; still accept a dotted token tldts can parse
	// when it has no forbidden characters (already checked).
	return !host.includes(':')
}

function isDnsLabelList(host: string) {
	return host.split('.').every((label) => {
		if (label.length === 0 || label.length > 63) return false
		return (
			/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label) ||
			/^xn--[a-z0-9-]+$/.test(label)
		)
	})
}

function isIpAddress(host: string) {
	if (isIpv4Address(host)) return true
	return isIpv6Address(host)
}

function isIpv4Address(host: string) {
	const parts = host.split('.')
	if (parts.length !== 4) return false
	return parts.every((part) => {
		if (!/^\d{1,3}$/.test(part)) return false
		const value = Number(part)
		return value >= 0 && value <= 255
	})
}

function looksLikeInvalidIpv4(host: string) {
	const parts = host.split('.')
	if (parts.length !== 4) return false
	return parts.every((part) => /^\d+$/.test(part))
}

function isIpv6Address(host: string) {
	const inner =
		host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
	if (!inner.includes(':')) return false
	try {
		return new URL(`http://[${inner}]/`).hostname === inner
	} catch {
		return false
	}
}
