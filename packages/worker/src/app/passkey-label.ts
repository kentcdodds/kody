/**
 * Best-effort map of common authenticator AAGUIDs to provider names for
 * passkey management labels. Names mirror the community-maintained registry:
 * https://github.com/passkeydeveloper/passkey-authenticator-aaguids
 *
 * Privacy-preserving platforms often report the all-zero AAGUID, so callers
 * should fall back to user-agent platform info when lookup fails.
 */
const commonAuthenticatorNames: Record<string, string> = {
	'ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4': 'Google Password Manager',
	'adce0002-35bc-c60a-648b-0b25f1f05503': 'Chrome on Mac',
	'fbfc3007-154e-4ecc-8c0b-6e020557d7bd': 'Apple Passwords',
	'dd4ec289-e01d-41c9-bb89-70fa845d4bf2': 'iCloud Keychain (Managed)',
	'08987058-cadc-4b81-b6e1-30de50dcbe96': 'Windows Hello',
	'9ddd1817-af5a-4672-a2b9-3e3dd95000a9': 'Windows Hello',
	'6028b017-b1d4-4c02-b4b3-afcdafc96bb2': 'Windows Hello',
	'bada5566-a7aa-401f-bd96-45619a55120d': '1Password',
	'd548826e-79b4-db40-a3d8-11116f7e8349': 'Bitwarden',
	'531126d6-e717-415c-9320-3d9aa6981239': 'Dashlane',
	'b78a0a55-6ef8-d246-a042-ba0f6d55050c': 'LastPass',
	'b84e4048-15dc-4dd0-8640-f4f60813c8af': 'NordPass',
	'50726f74-6f6e-5061-7373-50726f746f6e': 'Proton Pass',
	'0ea242b4-43c4-4a1b-8b17-dd6d0b6baec6': 'Keeper',
	'53414d53-554e-4700-0000-000000000000': 'Samsung Pass',
	// Common YubiKey models from FIDO MDS / community lists.
	'2fc0579f-8113-47ea-b116-bb5a8db9202a': 'YubiKey 5 NFC',
	'ee882879-721c-4913-9775-3dfcce97072a': 'YubiKey 5 Series',
	'fa2b99dc-9e39-4257-8f92-4a30d23c4118': 'YubiKey 5 NFC FIPS',
	'cb69481e-8ff7-4039-93ec-0a2729a154a8': 'YubiKey 5C',
	'c5ef55ff-ad9a-4b9f-b580-adebafe026d0': 'YubiKey 5 Series with Lightning',
	'a02167b9-ae71-4d63-a93a-9f135338449c': 'YubiKey 5Ci',
	'dd86a2da-86a0-4cbe-b462-4bd31f57bc6f': 'YubiKey Bio Series',
	'73bb0cd4-e502-49b8-9c6f-b59445bf720b': 'YubiKey 5 FIPS Series',
	'85203421-48f9-4355-9bc8-8a53846e54f2': 'YubiKey 5C NFC FIPS',
	'c1f9a0bc-1dd2-404a-b27f-8e2907723133': 'YubiKey 5 NFC FIPS',
}

const anonymousAaguid = '00000000-0000-0000-0000-000000000000'

export const passkeyNameMaxLength = 80

export function getAuthenticatorName(
	aaguid: string | null | undefined,
): string | undefined {
	const normalized = aaguid?.trim().toLowerCase()
	if (!normalized || normalized === anonymousAaguid) return undefined
	const name = Object.hasOwn(commonAuthenticatorNames, normalized)
		? commonAuthenticatorNames[normalized]
		: undefined
	return typeof name === 'string' ? name : undefined
}

export function describeUserAgentPlatform(
	userAgent: string | null | undefined,
): string | undefined {
	if (!userAgent) return undefined
	const ua = userAgent
	if (/iPhone/i.test(ua)) return 'iPhone'
	if (/iPad/i.test(ua)) return 'iPad'
	if (/Android/i.test(ua)) return 'Android'
	if (/CrOS/i.test(ua)) return 'ChromeOS'
	if (/Macintosh|Mac OS X/i.test(ua)) return 'macOS'
	if (/Windows/i.test(ua)) return 'Windows'
	if (/Linux/i.test(ua)) return 'Linux'
	return undefined
}

function genericPasskeyLabel(deviceType: string | null | undefined) {
	return deviceType === 'multiDevice'
		? 'Synced passkey'
		: 'Device-bound passkey'
}

/**
 * Build a default nickname at registration time from authenticator AAGUID
 * and/or the registering browser's platform.
 */
export function buildDefaultPasskeyName(input: {
	aaguid: string | null | undefined
	deviceType: string | null | undefined
	userAgent?: string | null | undefined
}): string {
	const provider = getAuthenticatorName(input.aaguid)
	const platform = describeUserAgentPlatform(input.userAgent)
	if (provider && platform) return `${provider} · ${platform}`
	if (provider) return provider
	if (platform) return `${genericPasskeyLabel(input.deviceType)} · ${platform}`
	return genericPasskeyLabel(input.deviceType)
}

export function normalizePasskeyName(value: string) {
	return value.trim().replace(/\s+/g, ' ')
}

export function validatePasskeyName(
	value: unknown,
): { ok: true; name: string } | { ok: false; error: string } {
	if (typeof value !== 'string') {
		return { ok: false, error: 'Name is required.' }
	}
	const name = normalizePasskeyName(value)
	if (name.length === 0) {
		return { ok: false, error: 'Name is required.' }
	}
	if (name.length > passkeyNameMaxLength) {
		return {
			ok: false,
			error: `Name must be ${passkeyNameMaxLength} characters or fewer.`,
		}
	}
	return { ok: true, name }
}
