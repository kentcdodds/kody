import { readFileSync } from 'node:fs'
import { parseJsonc } from '../../../../tools/ci/resource-utils.ts'

export type WranglerCompatibilitySettings = {
	compatibilityDate: string
	compatibilityFlags: Array<string>
}

function readWranglerCompatibilitySettings(
	configUrl: URL,
): WranglerCompatibilitySettings {
	const parsed = parseJsonc<{
		compatibility_date?: unknown
		compatibility_flags?: unknown
	}>(readFileSync(configUrl, 'utf8'))
	if (typeof parsed.compatibility_date !== 'string') {
		throw new Error(`Missing compatibility_date in ${configUrl.pathname}`)
	}
	if (
		!Array.isArray(parsed.compatibility_flags) ||
		parsed.compatibility_flags.some((flag) => typeof flag !== 'string')
	) {
		throw new Error(`Missing compatibility_flags in ${configUrl.pathname}`)
	}
	return {
		compatibilityDate: parsed.compatibility_date,
		compatibilityFlags: parsed.compatibility_flags,
	}
}

export function readMainWorkerWranglerCompatibility(): WranglerCompatibilitySettings {
	return readWranglerCompatibilitySettings(
		new URL('../../wrangler.jsonc', import.meta.url),
	)
}

export function readMockCloudflareWranglerCompatibility(): WranglerCompatibilitySettings {
	return readWranglerCompatibilitySettings(
		new URL(
			'../../../../packages/mock-servers/cloudflare/wrangler.jsonc',
			import.meta.url,
		),
	)
}
