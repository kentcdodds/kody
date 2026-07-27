import { describe, expect, test } from 'vitest'
import { resolveInboundEmailAuthVerdict } from './auth-verdict.ts'

describe('resolveInboundEmailAuthVerdict', () => {
	test('parses a full Cloudflare-style pass header as authenticated', () => {
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
	})

	test('marks dmarc fail as suspect', () => {
		expect(
			resolveInboundEmailAuthVerdict(
				'mx.cloudflare.net; spf=pass smtp.mailfrom=example.com; dkim=pass header.d=example.com; dmarc=fail header.from=example.com',
			),
		).toEqual({
			spf: 'pass',
			dkim: 'pass',
			dmarc: 'fail',
			authenticated: false,
			suspect: true,
			reason: 'Sender failed DMARC authentication.',
		})
	})

	test('spf fail with dkim pass is authenticated and not suspect', () => {
		expect(
			resolveInboundEmailAuthVerdict(
				'mx.cloudflare.net; spf=fail smtp.mailfrom=example.com; dkim=pass header.d=example.com; dmarc=none header.from=example.com',
			),
		).toEqual({
			spf: 'fail',
			dkim: 'pass',
			dmarc: 'none',
			authenticated: true,
			suspect: false,
			reason: null,
		})
	})

	test('spf fail without dkim pass is suspect', () => {
		expect(
			resolveInboundEmailAuthVerdict(
				'mx.cloudflare.net; spf=fail smtp.mailfrom=example.com; dkim=none header.d=example.com; dmarc=none header.from=example.com',
			),
		).toEqual({
			spf: 'fail',
			dkim: 'none',
			dmarc: 'none',
			authenticated: false,
			suspect: true,
			reason: 'Sender failed SPF and the message has no valid DKIM signature.',
		})
	})

	test('spf softfail without dkim pass is suspect', () => {
		expect(
			resolveInboundEmailAuthVerdict(
				'mx.cloudflare.net; spf=softfail smtp.mailfrom=example.com; dmarc=none header.from=example.com',
			),
		).toEqual({
			spf: 'softfail',
			dkim: 'unknown',
			dmarc: 'none',
			authenticated: false,
			suspect: true,
			reason:
				'Sender SPF soft-failed and the message has no valid DKIM signature.',
		})
	})

	test('parses ARC headers that include an i= clause', () => {
		expect(
			resolveInboundEmailAuthVerdict(
				'mx.cloudflare.net; i=1; spf=pass smtp.mailfrom=example.com; dkim=pass header.d=example.com; dmarc=pass header.from=example.com',
			),
		).toEqual({
			spf: 'pass',
			dkim: 'pass',
			dmarc: 'pass',
			authenticated: true,
			suspect: false,
			reason: null,
		})
	})

	test('multiple dkim clauses prefer pass over earlier non-pass results', () => {
		expect(
			resolveInboundEmailAuthVerdict(
				'mx.cloudflare.net; dkim=fail header.d=bad.example; dkim=pass header.d=example.com; spf=none; dmarc=none',
			),
		).toEqual({
			spf: 'none',
			dkim: 'pass',
			dmarc: 'none',
			authenticated: true,
			suspect: false,
			reason: null,
		})
	})

	test('null and empty input fail open', () => {
		expect(resolveInboundEmailAuthVerdict(null)).toEqual({
			spf: 'unknown',
			dkim: 'unknown',
			dmarc: 'unknown',
			authenticated: false,
			suspect: false,
			reason: null,
		})
		expect(resolveInboundEmailAuthVerdict('')).toEqual({
			spf: 'unknown',
			dkim: 'unknown',
			dmarc: 'unknown',
			authenticated: false,
			suspect: false,
			reason: null,
		})
	})

	test('garbage input fails open with unknown methods', () => {
		expect(
			resolveInboundEmailAuthVerdict('not-an-auth-results-header'),
		).toEqual({
			spf: 'unknown',
			dkim: 'unknown',
			dmarc: 'unknown',
			authenticated: false,
			suspect: false,
			reason: null,
		})
	})

	test('accepts uppercase method names and result tokens', () => {
		expect(
			resolveInboundEmailAuthVerdict(
				'MX.CLOUDFLARE.NET; SPF=PASS smtp.mailfrom=example.com; DKIM=PASS header.d=example.com; DMARC=PASS header.from=example.com',
			),
		).toEqual({
			spf: 'pass',
			dkim: 'pass',
			dmarc: 'pass',
			authenticated: true,
			suspect: false,
			reason: null,
		})
	})

	test('strips trailing comment parentheses from result tokens', () => {
		expect(
			resolveInboundEmailAuthVerdict(
				'mx.cloudflare.net; spf=pass (sender ip is 203.0.113.1); dkim=pass (good signature); dmarc=pass (p=none)',
			),
		).toEqual({
			spf: 'pass',
			dkim: 'pass',
			dmarc: 'pass',
			authenticated: true,
			suspect: false,
			reason: null,
		})
	})
})
