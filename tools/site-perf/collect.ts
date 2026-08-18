import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { isExecutedDirectly } from '../node-runtime.ts'

export type SitePerfVerdict = 'ok' | 'actionable' | 'human'

export type SitePerfBudget = {
	htmlBytes: number
	htmlBytesHuman: number
	sameOriginJsBytes: number
	sameOriginJsBytesHuman: number
	lcpImageBytes: number
	lcpImageBytesHuman: number
}

export type SitePerfFinding = {
	id: string
	severity: Exclude<SitePerfVerdict, 'ok'>
	message: string
}

export type SitePerfReport = {
	url: string
	fetchedAt: string
	htmlBytes: number
	cacheControl: string | null
	vary: string | null
	largestSameOriginJsBytes: number | null
	lcpImageBytes: number | null
	findings: Array<SitePerfFinding>
	verdict: SitePerfVerdict
}

export const defaultBudgetPath = path.join(import.meta.dirname, 'budget.json')

export async function loadSitePerfBudget(
	budgetPath = defaultBudgetPath,
): Promise<SitePerfBudget> {
	return JSON.parse(await readFile(budgetPath, 'utf8')) as SitePerfBudget
}

function hrefsMatching(html: string, pattern: RegExp) {
	return [...html.matchAll(pattern)].map((match) => match[1]).filter(Boolean)
}

function resolveUrl(base: string, href: string) {
	return new URL(href, base).href
}

function isSameOrigin(base: string, href: string) {
	return new URL(href, base).origin === new URL(base).origin
}

export function classifySitePerf(input: {
	url: string
	html: string
	cacheControl: string | null
	vary: string | null
	htmlBytes: number
	largestSameOriginJsBytes: number | null
	lcpImageBytes: number | null
	budget: SitePerfBudget
}): SitePerfReport {
	const findings: Array<SitePerfFinding> = []
	const { html, budget } = input

	if (!/rel=["']preload["'][^>]+as=["']image["']/.test(html)) {
		findings.push({
			id: 'missing-lcp-preload',
			severity: 'actionable',
			message: 'Homepage HTML is missing an LCP image preload.',
		})
	} else if (!html.includes('kody-base-640.webp')) {
		findings.push({
			id: 'lcp-preload-not-responsive',
			severity: 'actionable',
			message: 'LCP preload does not point at the 640w hero variant.',
		})
	}

	if (
		new URL(input.url).pathname === '/' &&
		html.includes('syntax-highlight-core')
	) {
		findings.push({
			id: 'shiki-on-home',
			severity: 'human',
			message: 'Homepage HTML preloads syntax-highlight-core (Shiki on /).',
		})
	}

	if (/turnstile\/v0\/api\.js/.test(html)) {
		findings.push({
			id: 'turnstile-in-ssr',
			severity: 'actionable',
			message: 'Turnstile script is present in the first HTML document.',
		})
	}

	if (
		input.cacheControl === 'no-store' &&
		new URL(input.url).pathname === '/'
	) {
		findings.push({
			id: 'home-no-store',
			severity: 'actionable',
			message: 'Anonymous homepage HTML is Cache-Control: no-store.',
		})
	}

	if (input.htmlBytes > budget.htmlBytesHuman) {
		findings.push({
			id: 'html-too-large',
			severity: 'human',
			message: `HTML is ${input.htmlBytes} bytes (human threshold ${budget.htmlBytesHuman}).`,
		})
	} else if (input.htmlBytes > budget.htmlBytes) {
		findings.push({
			id: 'html-over-budget',
			severity: 'actionable',
			message: `HTML is ${input.htmlBytes} bytes (budget ${budget.htmlBytes}).`,
		})
	}

	if (
		input.largestSameOriginJsBytes !== null &&
		input.largestSameOriginJsBytes > budget.sameOriginJsBytesHuman
	) {
		findings.push({
			id: 'js-too-large',
			severity: 'human',
			message: `Largest same-origin JS is ${input.largestSameOriginJsBytes} bytes (human threshold ${budget.sameOriginJsBytesHuman}).`,
		})
	} else if (
		input.largestSameOriginJsBytes !== null &&
		input.largestSameOriginJsBytes > budget.sameOriginJsBytes
	) {
		findings.push({
			id: 'js-over-budget',
			severity: 'actionable',
			message: `Largest same-origin JS is ${input.largestSameOriginJsBytes} bytes (budget ${budget.sameOriginJsBytes}).`,
		})
	}

	if (
		input.lcpImageBytes !== null &&
		input.lcpImageBytes > budget.lcpImageBytesHuman
	) {
		findings.push({
			id: 'lcp-image-too-large',
			severity: 'human',
			message: `LCP image is ${input.lcpImageBytes} bytes (human threshold ${budget.lcpImageBytesHuman}).`,
		})
	} else if (
		input.lcpImageBytes !== null &&
		input.lcpImageBytes > budget.lcpImageBytes
	) {
		findings.push({
			id: 'lcp-image-over-budget',
			severity: 'actionable',
			message: `LCP image is ${input.lcpImageBytes} bytes (budget ${budget.lcpImageBytes}).`,
		})
	}

	const verdict: SitePerfVerdict = findings.some((f) => f.severity === 'human')
		? 'human'
		: findings.some((f) => f.severity === 'actionable')
			? 'actionable'
			: 'ok'

	return {
		url: input.url,
		fetchedAt: new Date(0).toISOString(),
		htmlBytes: input.htmlBytes,
		cacheControl: input.cacheControl,
		vary: input.vary,
		largestSameOriginJsBytes: input.largestSameOriginJsBytes,
		lcpImageBytes: input.lcpImageBytes,
		findings,
		verdict,
	}
}

async function byteLengthOf(url: string): Promise<number | null> {
	try {
		const head = await fetch(url, { method: 'HEAD' })
		const length = head.headers.get('Content-Length')
		if (length && Number.isFinite(Number(length))) return Number(length)
		if (!head.ok) return null
		const body = await fetch(url)
		if (!body.ok) return null
		return (await body.arrayBuffer()).byteLength
	} catch {
		return null
	}
}

export async function collectSitePerf(input: {
	url: string
	budget?: SitePerfBudget
	now?: Date
}): Promise<SitePerfReport> {
	const budget = input.budget ?? (await loadSitePerfBudget())
	const response = await fetch(input.url, {
		headers: { Accept: 'text/html' },
		redirect: 'follow',
	})
	const html = await response.text()
	const htmlBytes = new TextEncoder().encode(html).byteLength
	const scriptHrefs = hrefsMatching(html, /<script[^>]+src=["']([^"']+)["']/gi)
	const preloadHrefs = hrefsMatching(
		html,
		/<link[^>]+rel=["'](?:modulepreload|preload)["'][^>]+href=["']([^"']+)["']/gi,
	)
	const sameOriginJs = [...scriptHrefs, ...preloadHrefs]
		.filter((href) => href.endsWith('.js'))
		.filter((href) => isSameOrigin(input.url, href))
		.map((href) => resolveUrl(input.url, href))

	const jsSizes = await Promise.all(sameOriginJs.map(byteLengthOf))
	const largestSameOriginJsBytes = jsSizes.reduce<number | null>(
		(max, size) => {
			if (size === null) return max
			if (max === null || size > max) return size
			return max
		},
		null,
	)

	const lcpHref =
		hrefsMatching(
			html,
			/<link[^>]+rel=["']preload["'][^>]+href=["']([^"']+\.webp)["']/gi,
		)[0] ?? null
	const lcpImageBytes = lcpHref
		? await byteLengthOf(resolveUrl(input.url, lcpHref))
		: null

	const report = classifySitePerf({
		url: response.url || input.url,
		html,
		cacheControl: response.headers.get('Cache-Control'),
		vary: response.headers.get('Vary'),
		htmlBytes,
		largestSameOriginJsBytes,
		lcpImageBytes,
		budget,
	})
	report.fetchedAt = (input.now ?? new Date()).toISOString()
	return report
}

function parseArgs(argv: Array<string>) {
	let url = 'https://kody.codes/'
	let json = false
	let exitZero = false
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index]
		if (arg === '--json') json = true
		else if (arg === '--exit-zero') exitZero = true
		else if (arg === '--url') {
			const value = argv[index + 1]
			if (!value) throw new Error('--url requires a value')
			url = value
			index += 1
		}
	}
	return { url, json, exitZero }
}

export async function main(argv = process.argv.slice(2)) {
	const { url, json, exitZero } = parseArgs(argv)
	const report = await collectSitePerf({ url })
	if (json) {
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
	} else {
		process.stdout.write(
			`${report.verdict} ${report.url} html=${report.htmlBytes} js=${report.largestSameOriginJsBytes ?? 'n/a'} lcp=${report.lcpImageBytes ?? 'n/a'}\n`,
		)
		for (const finding of report.findings) {
			process.stdout.write(`- [${finding.severity}] ${finding.message}\n`)
		}
	}
	if (exitZero) return
	if (report.verdict === 'human') process.exitCode = 2
	else if (report.verdict === 'actionable') process.exitCode = 1
}

if (isExecutedDirectly(import.meta.url)) {
	void main()
}
