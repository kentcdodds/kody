import { type Handle, css } from 'remix/component'
import {
	descriptionCss,
	mutedLinkCss,
	pageDescriptionCss,
	pageHeaderCss,
	pageTitleCss,
	stackedPageCss,
} from '#universal/styles/style-primitives.ts'

/**
 * Public contact page. Channels already published on support, privacy, pricing,
 * FAQ, and security.txt — no invented phone numbers or addresses.
 */
export function ContactRoute(_handle: Handle) {
	return () => (
		<section mix={css(pageCss)}>
			<header mix={css(pageHeaderCss)}>
				<h1 mix={css(pageTitleCss)}>Contact Kody</h1>
				<p mix={css(pageDescriptionCss)}>
					How to reach the people who run the hosted Kody service at kody.codes.
				</p>
			</header>

			<p mix={css(descriptionCss)}>
				For help with your account, billing, connections, packages, or anything
				else on the hosted service, email{' '}
				<a href="mailto:support@kody.codes" mix={css(mutedLinkCss)}>
					support@kody.codes
				</a>
				. A lot of what you experience as Kody is the agent you connected — if
				something feels off, try the same request with a stronger model before
				writing in; stronger models usually get more out of search, packages,
				and memory.
			</p>

			<p mix={css(descriptionCss)}>
				For teams and sales questions about plans beyond Free, email{' '}
				<a href="mailto:kody@kody.codes" mix={css(mutedLinkCss)}>
					kody@kody.codes
				</a>
				. Pricing details, including the $0 Free plan caps, are on{' '}
				<a href="/pricing" mix={css(mutedLinkCss)}>
					Pricing
				</a>
				.
			</p>

			<p mix={css(descriptionCss)}>
				Security reports for the hosted product go to{' '}
				<a href="mailto:me@kentcdodds.com" mix={css(mutedLinkCss)}>
					me@kentcdodds.com
				</a>{' '}
				or through{' '}
				<a
					href="https://github.com/kentcdodds/kody/security/advisories/new"
					mix={css(mutedLinkCss)}
					target="_blank"
					rel="noreferrer noopener"
				>
					GitHub private vulnerability reporting
				</a>
				. The public policy is in{' '}
				<a
					href="https://github.com/kentcdodds/kody/blob/main/SECURITY.md"
					mix={css(mutedLinkCss)}
					target="_blank"
					rel="noreferrer noopener"
				>
					SECURITY.md
				</a>
				, and{' '}
				<a href="/.well-known/security.txt" mix={css(mutedLinkCss)}>
					/.well-known/security.txt
				</a>{' '}
				lists the same contacts.
			</p>

			<p mix={css(descriptionCss)}>
				Community chat is on the official Discord (
				<a href="/discord" mix={css(mutedLinkCss)}>
					join via /discord
				</a>
				). Product source, issues, and pull requests live at{' '}
				<a
					href="https://github.com/kentcdodds/kody"
					mix={css(mutedLinkCss)}
					target="_blank"
					rel="noreferrer noopener"
				>
					github.com/kentcdodds/kody
				</a>
				. Site blocked by a DNS filter, or signup mail never arrives? See{' '}
				<a href="/docs/cant-open-or-get-mail" mix={css(mutedLinkCss)}>
					If you can&apos;t open kody.codes or get mail from us
				</a>
				. More product context is on{' '}
				<a href="/about" mix={css(mutedLinkCss)}>
					About
				</a>
				,{' '}
				<a href="/faq" mix={css(mutedLinkCss)}>
					FAQ
				</a>
				, and{' '}
				<a href="/support" mix={css(mutedLinkCss)}>
					Support
				</a>
				.
			</p>
		</section>
	)
}

const pageCss = {
	...stackedPageCss,
	maxWidth: '42rem',
	margin: '0 auto',
}
