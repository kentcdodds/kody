import { expect, test } from 'vitest'
import { resolveInboundEmailAuthVerdict } from './auth-verdict.ts'

test('resolveInboundEmailAuthVerdict parses Authentication-Results into auth/suspect verdicts', () => {
	expect(
		resolveInboundEmailAuthVerdict(
			'mx.cloudflare.net; spf=pass smtp.mailfrom=example.com; dkim=pass header.d=example.com; dmarc=pass header.from=example.com',
		),
	).toEqual({
		spf: 'pass',
		dkim: 'pass',
		dmarc: 'pass',
		authenticated: true,
		suspect: false,
		reason: null,
	})

	// ARC i= clauses and parenthetical comments are ignored; case is normalized.
	expect(
		resolveInboundEmailAuthVerdict(
			'MX.CLOUDFLARE.NET; i=1; SPF=PASS (sender ip is 203.0.113.1); DKIM=PASS (good signature); DMARC=PASS (p=none)',
		),
	).toMatchObject({
		spf: 'pass',
		dkim: 'pass',
		dmarc: 'pass',
		authenticated: true,
		suspect: false,
	})

	// Multiple DKIM results prefer pass over earlier non-pass results.
	expect(
		resolveInboundEmailAuthVerdict(
			'mx.cloudflare.net; dkim=fail header.d=bad.example; dkim=pass header.d=example.com; spf=none; dmarc=none',
		),
	).toMatchObject({
		dkim: 'pass',
		authenticated: true,
		suspect: false,
	})

	expect(
		resolveInboundEmailAuthVerdict(
			'mx.cloudflare.net; spf=pass smtp.mailfrom=example.com; dkim=pass header.d=example.com; dmarc=fail header.from=example.com',
		),
	).toMatchObject({
		dmarc: 'fail',
		authenticated: false,
		suspect: true,
		reason: 'Sender failed DMARC authentication.',
	})

	// SPF fail with DKIM pass is authenticated; without DKIM it is suspect.
	expect(
		resolveInboundEmailAuthVerdict(
			'mx.cloudflare.net; spf=fail smtp.mailfrom=example.com; dkim=pass header.d=example.com; dmarc=none header.from=example.com',
		),
	).toMatchObject({
		spf: 'fail',
		dkim: 'pass',
		authenticated: true,
		suspect: false,
	})
	expect(
		resolveInboundEmailAuthVerdict(
			'mx.cloudflare.net; spf=fail smtp.mailfrom=example.com; dkim=none header.d=example.com; dmarc=none header.from=example.com',
		),
	).toMatchObject({
		authenticated: false,
		suspect: true,
		reason: 'Sender failed SPF and the message has no valid DKIM signature.',
	})
	expect(
		resolveInboundEmailAuthVerdict(
			'mx.cloudflare.net; spf=softfail smtp.mailfrom=example.com; dmarc=none header.from=example.com',
		),
	).toMatchObject({
		spf: 'softfail',
		dkim: 'unknown',
		authenticated: false,
		suspect: true,
	})

	// Missing / unparseable headers fail open (not authenticated, not suspect).
	for (const input of [null, '', 'not-an-auth-results-header'] as const) {
		expect(resolveInboundEmailAuthVerdict(input)).toEqual({
			spf: 'unknown',
			dkim: 'unknown',
			dmarc: 'unknown',
			authenticated: false,
			suspect: false,
			reason: null,
		})
	}
})
