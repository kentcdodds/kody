import { mkdir, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import path from 'node:path'

export const e2eCloudflareMockAccountId = 'cf_account_mock_123'

export const e2eCloudflareMockStatePath = path.resolve(
	process.cwd(),
	'.wrangler/state/e2e/cloudflare-mock.json',
)

export type E2eCloudflareMockState = {
	origin: string
	token: string
	accountId: string
}

export async function writeE2eCloudflareMockState(
	state: E2eCloudflareMockState,
) {
	await mkdir(path.dirname(e2eCloudflareMockStatePath), { recursive: true })
	await writeFile(
		e2eCloudflareMockStatePath,
		`${JSON.stringify(state, null, 2)}\n`,
		'utf8',
	)
}

export function readE2eCloudflareMockState(): E2eCloudflareMockState {
	let raw: string
	try {
		raw = readFileSync(e2eCloudflareMockStatePath, 'utf8')
	} catch {
		throw new Error(
			`Missing Cloudflare mock state at ${e2eCloudflareMockStatePath}. The Playwright webServer starts the mock and writes this file.`,
		)
	}
	const parsed = JSON.parse(raw) as Partial<E2eCloudflareMockState>
	if (
		typeof parsed.origin !== 'string' ||
		parsed.origin.length === 0 ||
		typeof parsed.token !== 'string' ||
		parsed.token.length === 0 ||
		typeof parsed.accountId !== 'string' ||
		parsed.accountId.length === 0
	) {
		throw new Error(
			`Invalid Cloudflare mock state at ${e2eCloudflareMockStatePath}.`,
		)
	}
	return {
		origin: parsed.origin,
		token: parsed.token,
		accountId: parsed.accountId,
	}
}
