import { expect, test } from 'vitest'
import { buildVerificationEmail } from './messages.ts'
import { renderTransactionalEmail } from './template.ts'

test('transactional emails escape untrusted content and put action URLs in both parts', () => {
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

	const verificationUrl = 'https://kody.codes/verify-email?token=abc123'
	const verification = buildVerificationEmail({
		appBaseUrl: 'https://kody.codes',
		verificationUrl,
	})
	expect(verification.html).toContain(verificationUrl)
	expect(verification.text).toContain(verificationUrl)
	expect(verification.html).toContain('https://kody.codes/images/kody-mark.png')
})
