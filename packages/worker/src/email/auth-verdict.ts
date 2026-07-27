export const emailAuthMethodResults = [
	'pass',
	'fail',
	'softfail',
	'neutral',
	'none',
	'policy',
	'temperror',
	'permerror',
	'unknown',
] as const
export type EmailAuthMethodResult = (typeof emailAuthMethodResults)[number]

export type EmailAuthVerdict = {
	spf: EmailAuthMethodResult
	dkim: EmailAuthMethodResult
	dmarc: EmailAuthMethodResult
	authenticated: boolean
	suspect: boolean
	reason: string | null
}

const methodClausePattern = /^(spf|dkim|dmarc)=([^\s(;]+)/i

const knownMethodResults = new Set<string>(emailAuthMethodResults)

function parseMethodResultToken(token: string): EmailAuthMethodResult {
	const normalized = token.toLowerCase()
	if (knownMethodResults.has(normalized)) {
		return normalized as EmailAuthMethodResult
	}
	return 'unknown'
}

function mergeMethodResult(
	current: EmailAuthMethodResult,
	next: EmailAuthMethodResult,
): EmailAuthMethodResult {
	if (current === 'pass' || next === 'pass') return 'pass'
	if (current !== 'unknown') return current
	return next
}

function parseAuthMethodResults(authResults: string | null): {
	spf: EmailAuthMethodResult
	dkim: EmailAuthMethodResult
	dmarc: EmailAuthMethodResult
} {
	let spf: EmailAuthMethodResult = 'unknown'
	let dkim: EmailAuthMethodResult = 'unknown'
	let dmarc: EmailAuthMethodResult = 'unknown'
	if (!authResults?.trim()) {
		return { spf, dkim, dmarc }
	}

	for (const clause of authResults.split(';')) {
		const match = clause.trim().match(methodClausePattern)
		if (!match) continue
		const method = match[1]!.toLowerCase()
		const result = parseMethodResultToken(match[2]!)
		if (method === 'spf') {
			spf = mergeMethodResult(spf, result)
		} else if (method === 'dkim') {
			dkim = mergeMethodResult(dkim, result)
		} else if (method === 'dmarc') {
			dmarc = mergeMethodResult(dmarc, result)
		}
	}

	return { spf, dkim, dmarc }
}

function suspectReason(input: {
	spf: EmailAuthMethodResult
	dkim: EmailAuthMethodResult
	dmarc: EmailAuthMethodResult
}): string {
	if (input.dmarc === 'fail') {
		return 'Sender failed DMARC authentication.'
	}
	if (input.spf === 'fail' && input.dkim !== 'pass') {
		return 'Sender failed SPF and the message has no valid DKIM signature.'
	}
	return 'Sender SPF soft-failed and the message has no valid DKIM signature.'
}

/**
 * Resolve SPF/DKIM/DMARC method results from an Authentication-Results (or
 * ARC-Authentication-Results) header into a quarantine verdict.
 *
 * Policy:
 * - `authenticated` when DMARC is `pass`, or when (SPF or DKIM is `pass`) and
 *   DMARC is not `fail`.
 * - `suspect` when DMARC is `fail`, or SPF is `fail`/`softfail` without a
 *   DKIM `pass`.
 * - Missing header entirely (all three methods `unknown`) fails open:
 *   authenticated false, suspect false — so locally-injected/dev mail and
 *   unexpected upstream changes do not quarantine everything.
 * - `reason` is set only when suspect.
 */
export function resolveInboundEmailAuthVerdict(
	authResults: string | null,
): EmailAuthVerdict {
	const { spf, dkim, dmarc } = parseAuthMethodResults(authResults)

	if (spf === 'unknown' && dkim === 'unknown' && dmarc === 'unknown') {
		return {
			spf,
			dkim,
			dmarc,
			authenticated: false,
			suspect: false,
			reason: null,
		}
	}

	const authenticated =
		dmarc === 'pass' ||
		((spf === 'pass' || dkim === 'pass') && dmarc !== 'fail')
	const suspect =
		dmarc === 'fail' ||
		(spf === 'fail' && dkim !== 'pass') ||
		(spf === 'softfail' && dkim !== 'pass')

	return {
		spf,
		dkim,
		dmarc,
		authenticated,
		suspect,
		reason: suspect ? suspectReason({ spf, dkim, dmarc }) : null,
	}
}
