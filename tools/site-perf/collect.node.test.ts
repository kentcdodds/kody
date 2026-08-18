import { expect, test } from 'vitest'
import { classifySitePerf, type SitePerfBudget } from './collect.ts'

const budget: SitePerfBudget = {
	htmlBytes: 1000,
	sameOriginJsBytes: 1000,
	lcpImageBytes: 1000,
}

const healthyHtml = `
<link rel="preload" as="image" href="/images/hero/kody-base-640.webp" />
<script type="module" src="/client-entry.js"></script>
`

test('classifySitePerf returns ok when budgets and landing signals pass', () => {
	const report = classifySitePerf({
		url: 'https://kody.codes/',
		html: healthyHtml,
		cacheControl: 'public, max-age=60, stale-while-revalidate=300',
		vary: 'Cookie',
		htmlBytes: 800,
		largestSameOriginJsBytes: 800,
		lcpImageBytes: 800,
		budget,
	})
	expect(report.verdict).toBe('ok')
	expect(report.findings).toEqual([])
})

test('classifySitePerf marks missing LCP preload and no-store as needs-fix', () => {
	const report = classifySitePerf({
		url: 'https://kody.codes/',
		html: '<html></html>',
		cacheControl: 'no-store',
		vary: null,
		htmlBytes: 800,
		largestSameOriginJsBytes: 800,
		lcpImageBytes: null,
		budget,
	})
	expect(report.verdict).toBe('needs-fix')
	expect(report.findings.map((finding) => finding.id).sort()).toEqual([
		'home-no-store',
		'missing-lcp-preload',
	])
})

test('classifySitePerf treats Shiki on / and oversized JS as needs-fix, not human', () => {
	const report = classifySitePerf({
		url: 'https://kody.codes/',
		html: `${healthyHtml}<link rel="modulepreload" href="/assets/syntax-highlight-core-abc.js" />`,
		cacheControl: 'public, max-age=60',
		vary: 'Cookie',
		htmlBytes: 800,
		largestSameOriginJsBytes: 3000,
		lcpImageBytes: 800,
		budget,
	})
	expect(report.verdict).toBe('needs-fix')
	expect(report.findings.map((finding) => finding.id)).toEqual([
		'shiki-on-home',
		'js-over-budget',
	])
})
