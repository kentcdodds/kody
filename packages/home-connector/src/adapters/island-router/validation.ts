import { isIP } from 'node:net'
import { type HomeConnectorConfig } from '../../config.ts'
import {
	type IslandRouterConfigStatus,
	type IslandRouterHostIdentity,
} from './types.ts'

const macAddressPattern =
	/^(?<octets>[0-9a-fA-F]{2}([:-][0-9a-fA-F]{2}){5})$/
const hostnamePattern =
	/^(?=.{1,253}$)(?!-)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.(?!-)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/
const sha256FingerprintPattern = /^SHA256:[A-Za-z0-9+/]+={0,2}$/
const md5FingerprintPattern = /^MD5:(?:[0-9a-fA-F]{2}:){15}[0-9a-fA-F]{2}$/

function normalizeMacAddress(value: string) {
	const octets = value
		.trim()
		.toLowerCase()
		.replaceAll('-', ':')
		.split(':')
	return octets.map((octet) => octet.padStart(2, '0')).join(':')
}

function normalizeIpv6(value: string) {
	return value.trim().toLowerCase()
}

export function validateIslandRouterHost(value: string): IslandRouterHostIdentity {
	const trimmed = value.trim()
	if (trimmed.length === 0) {
		throw new Error('Host must not be empty.')
	}

	if (isIP(trimmed) === 4) {
		return {
			kind: 'ipv4',
			value: trimmed,
			normalizedValue: trimmed,
		}
	}

	if (isIP(trimmed) === 6) {
		return {
			kind: 'ipv6',
			value: trimmed,
			normalizedValue: normalizeIpv6(trimmed),
		}
	}

	if (macAddressPattern.test(trimmed)) {
		return {
			kind: 'mac',
			value: trimmed,
			normalizedValue: normalizeMacAddress(trimmed),
		}
	}

	if (hostnamePattern.test(trimmed)) {
		return {
			kind: 'hostname',
			value: trimmed,
			normalizedValue: trimmed.toLowerCase(),
		}
	}

	throw new Error(
		'Host must be a valid IPv4 address, IPv6 address, MAC address, or hostname.',
	)
}

export function validateIslandRouterFingerprint(value: string) {
	const trimmed = value.trim()
	if (
		!sha256FingerprintPattern.test(trimmed) &&
		!md5FingerprintPattern.test(trimmed)
	) {
		throw new Error(
			'ISLAND_ROUTER_HOST_FINGERPRINT must be an SSH SHA256:... or MD5:... fingerprint.',
		)
	}

	return trimmed.startsWith('MD5:')
		? `MD5:${trimmed.slice(4).toLowerCase()}`
		: trimmed
}

export function getIslandRouterConfigStatus(
	config: HomeConnectorConfig,
): IslandRouterConfigStatus {
	const missingFields: Array<string> = []
	if (!config.islandRouterHost) missingFields.push('ISLAND_ROUTER_HOST')
	if (!config.islandRouterUsername) missingFields.push('ISLAND_ROUTER_USERNAME')
	if (!config.islandRouterPrivateKeyPath) {
		missingFields.push('ISLAND_ROUTER_PRIVATE_KEY_PATH')
	}

	const warnings: Array<string> = []
	let verificationConfigValid = true
	let verificationMode: IslandRouterConfigStatus['verificationMode'] = 'none'

	if (config.islandRouterKnownHostsPath) {
		verificationMode = 'known-hosts'
		if (config.islandRouterHostFingerprint) {
			warnings.push(
				'ISLAND_ROUTER_KNOWN_HOSTS_PATH is set, so it will be used instead of ISLAND_ROUTER_HOST_FINGERPRINT.',
			)
		}
	} else if (config.islandRouterHostFingerprint) {
		verificationMode = 'fingerprint'
		try {
			validateIslandRouterFingerprint(config.islandRouterHostFingerprint)
		} catch (error) {
			verificationConfigValid = false
			warnings.push(
				error instanceof Error ? error.message : String(error),
			)
		}
	} else {
		warnings.push(
			'No Island router host verification was configured. Set ISLAND_ROUTER_KNOWN_HOSTS_PATH or ISLAND_ROUTER_HOST_FINGERPRINT for safer SSH verification.',
		)
	}

	return {
		configured: missingFields.length === 0 && verificationConfigValid,
		missingFields,
		verificationMode,
		warnings,
	}
}

export function assertIslandRouterConfigured(config: HomeConnectorConfig) {
	const status = getIslandRouterConfigStatus(config)
	if (!status.configured) {
		const details = [
			...(status.missingFields.length > 0
				? [`Missing: ${status.missingFields.join(', ')}`]
				: []),
			...(status.warnings.length > 0 ? status.warnings : []),
		].join(' ')
		throw new Error(
			`Island router SSH diagnostics are not configured. ${details}`.trim(),
		)
	}
	if (
		config.islandRouterHostFingerprint &&
		!config.islandRouterKnownHostsPath
	) {
		validateIslandRouterFingerprint(config.islandRouterHostFingerprint)
	}
	return status
}
