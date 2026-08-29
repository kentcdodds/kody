import { expect, test } from 'vitest'
import {
	buildBillingSuccessEmail,
	buildConnectAgentEmail,
	buildUserEntitlementWarningEmail,
	buildUserErrorRateEmail,
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

	const warning = buildUserEntitlementWarningEmail({
		appBaseUrl: 'https://kody.codes',
		billingUrl: 'https://kody.codes/account/billing',
		usageUrl: 'https://kody.codes/account/usage',
		kind: 'approaching',
		warnings: [
			{
				label: 'execute calls per day',
				current: 200,
				limit: 250,
				percentOfLimit: 0.8,
			},
		],
	})
	expect(warning.subject).toContain('approaching')
	expect(warning.html).toContain('https://kody.codes/account/billing')
	expect(warning.text).toContain('https://kody.codes/account/usage')
	expect(warning.html).toContain('200 of 250 (80%)')

	const reached = buildUserEntitlementWarningEmail({
		appBaseUrl: 'https://kody.codes',
		billingUrl: 'https://kody.codes/account/billing',
		usageUrl: 'https://kody.codes/account/usage',
		kind: 'reached',
		warnings: [
			{
				label: 'execute calls per day',
				current: 250,
				limit: 250,
				percentOfLimit: 1,
			},
		],
	})
	expect(reached.subject).toContain('reached')
	expect(reached.html).toContain('250 of 250 (100%)')

	const connect = buildConnectAgentEmail({
		appBaseUrl: 'https://kody.codes',
		onboardingUrl: 'https://kody.codes/onboarding',
	})
	expect(connect.subject).toContain('Connect your agent')
	expect(connect.html).toContain('https://kody.codes/onboarding')

	const billing = buildBillingSuccessEmail({
		appBaseUrl: 'https://kody.codes',
		billingUrl: 'https://kody.codes/account/billing',
		discordUrl: 'https://kcd.im/kody-discord',
		planLabel: 'Pro',
	})
	expect(billing.subject).toContain('Pro')
	expect(billing.html).toContain('https://kcd.im/kody-discord')
	expect(billing.text).toContain('https://kody.codes/account/billing')

	const errorRate = buildUserErrorRateEmail({
		appBaseUrl: 'https://kody.codes',
		activityUrl: 'https://kody.codes/account/activity',
		triagePackageUrl: 'https://kody.codes/@kentcdodds/kody-issue-triage',
		errorCount: 10,
		eventCount: 40,
	})
	expect(errorRate.html).toContain('https://kody.codes/account/activity')
	expect(errorRate.text).toContain('/@kentcdodds/kody-issue-triage')
	expect(errorRate.html).toContain('25%')
})
