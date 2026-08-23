import { expect, test } from 'vitest'
import {
	buildUserEntitlementWarningEmail,
	buildVerificationEmail,
} from './messages.ts'
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
	expect(verification.html).toContain(
		'https://kody.codes/images/kody-lantern.png',
	)

	const warning = buildUserEntitlementWarningEmail({
		appBaseUrl: 'https://kody.codes',
		billingUrl: 'https://kody.codes/account/billing',
		usageUrl: 'https://kody.codes/account/usage',
		warnings: [
			{
				label: 'execute calls per day',
				current: 200,
				limit: 250,
				percentOfLimit: 0.8,
			},
		],
	})
	expect(warning.html).toContain('https://kody.codes/account/billing')
	expect(warning.text).toContain('https://kody.codes/account/usage')
	expect(warning.html).toContain('execute calls per day')
	expect(warning.html).toContain('https://kody.codes/images/kody-lantern.png')
	expect(warning.html).toContain('https://kody.codes/images/kody-mark.png')
})
