import { afterEach, expect, test, vi } from 'vitest'
import { createScarfPageTracker, scarfPageUrl } from './scarf-analytics.ts'

afterEach(() => vi.unstubAllGlobals())

test('only public marketing paths on the production host are eligible', () => {
	for (const path of [
		'/',
		'/pricing',
		'/faq',
		'/blog/kody-vs-executor',
		'/docs/memory',
	]) {
		expect(scarfPageUrl(`https://kody.codes${path}?token=private#secret`)).toBe(
			`https://kody.codes${path}`,
		)
	}
	for (const path of [
		'/account',
		'/admin',
		'/login',
		'/signup',
		'/onboarding',
		'/oauth/authorize',
		'/mcp',
		'/docs.md',
		'/docs/memory.md',
		'/@kentcdodds',
		'/blog/private/data',
	]) {
		expect(scarfPageUrl(`https://kody.codes${path}`)).toBeNull()
	}
	for (const origin of [
		'http://localhost:3000',
		'https://preview.kody.codes',
		'https://kody.run',
		'http://kody.codes',
	]) {
		expect(scarfPageUrl(`${origin}/pricing`)).toBeNull()
	}
})

test('beacons send only the public path, omit referrers, and deduplicate a page', () => {
	const pixels: Array<{ src: string; referrerPolicy: string }> = []
	vi.stubGlobal(
		'Image',
		class {
			src = ''
			referrerPolicy = ''
			constructor() {
				pixels.push(this)
			}
		},
	)
	const location = {
		href: 'https://kody.codes/pricing?email=private@example.com#private',
	}
	vi.stubGlobal('window', { location })
	vi.stubGlobal('navigator', {})
	const track = createScarfPageTracker()
	track()
	track()
	expect(pixels).toHaveLength(1)
	const pixel = pixels[0]!
	expect(pixel.referrerPolicy).toBe('no-referrer')
	const url = new URL(pixel.src)
	expect(url.origin).toBe('https://static.scarf.sh')
	expect(url.searchParams.get('Page')).toBe('https://kody.codes/pricing')
	expect(pixel.src).not.toContain('private')
	location.href = 'https://kody.codes/account?token=private'
	track()
	expect(pixels).toHaveLength(1)
	location.href = 'https://kody.codes/pricing'
	track()
	expect(pixels).toHaveLength(2)
	expect(pixels[1]!.src).not.toBe(pixel.src)
})

test.each([{ doNotTrack: '1' }, { globalPrivacyControl: true }])(
	'honors browser privacy preference %j',
	(navigator) => {
		const image = vi.fn()
		vi.stubGlobal('Image', image)
		vi.stubGlobal('window', { location: { href: 'https://kody.codes/' } })
		vi.stubGlobal('navigator', navigator)
		createScarfPageTracker()()
		expect(image).not.toHaveBeenCalled()
	},
)
