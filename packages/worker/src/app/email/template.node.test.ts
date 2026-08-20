import { expect, test } from 'vitest'
import { buildVerificationEmail } from './messages.ts'
import { renderTransactionalEmail } from './template.ts'

test('renderTransactionalEmail escapes untrusted content and mirrors the action in the text part', () => {
	const email = renderTransactionalEmail({
		appBaseUrl: 'https://kody.codes',
		subject: 'Subject <script>',
		preheader: 'Preheader "quoted"',
		heading: 'Heading & more',
		body: ['Body <b>text</b>'],
		action: {
			label: 'Do the thing',
			url: 'https://kody.codes/verify-email?token=a&redirectTo=/x',
		},
		afterAction: ['Expires soon.'],
		footnote: 'Ignore if unexpected.',
	})

	expect(email.html).not.toContain('<script>')
	expect(email.html).toContain('Heading &amp; more')
	expect(email.html).toContain('Body &lt;b&gt;text&lt;/b&gt;')
	expect(email.html).toContain(
		'https://kody.codes/verify-email?token=a&amp;redirectTo=/x',
	)
	expect(email.text).toContain(
		'Do the thing: https://kody.codes/verify-email?token=a&redirectTo=/x',
	)
	expect(email.text).toContain('Expires soon.')
	expect(email.text).toContain('Ignore if unexpected.')
	expect(email.html).not.toContain('kody-lantern')
})

test('buildVerificationEmail links to the verification url in both parts', () => {
	const verificationUrl = 'https://kody.codes/verify-email?token=abc123'
	const email = buildVerificationEmail({
		appBaseUrl: 'https://kody.codes',
		verificationUrl,
	})

	expect(email.subject).toMatch(/verify your email/i)
	expect(email.html).toContain(verificationUrl)
	expect(email.text).toContain(verificationUrl)
	expect(email.html).toContain('https://kody.codes/images/kody-mark.png')
	expect(email.html).toContain('alt="Kody"')
	expect(email.html).toContain('https://kody.codes/images/kody-lantern.webp')
	expect(email.html).toMatch(
		/<td align="center">\s*<img src="https:\/\/kody\.codes\/images\/kody-lantern\.webp"/,
	)
	expect(email.html).toContain('width="96"')
	expect(email.html).toContain('This link expires in 24 hours.')
	expect(email.html.indexOf('This link expires in 24 hours.')).toBeLessThan(
		email.html.indexOf('kody-lantern.webp'),
	)
})
