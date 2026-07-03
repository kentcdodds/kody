import { type Handle, css } from 'remix/ui'
import { colors, spacing, typography } from '#client/styles/tokens.ts'
import {
	cardCss,
	cardTitleCss,
	descriptionCss,
	mutedLinkCss,
	pageDescriptionCss,
	pageHeaderCss,
	pageTitleCss,
	stackedPageCss,
} from '#client/styles/style-primitives.ts'

export function PrivacyRoute(_handle: Handle) {
	return () => (
		<section mix={css(pageCss)}>
			<header mix={css(pageHeaderCss)}>
				<h1 mix={css(pageTitleCss)}>Privacy</h1>
				<p mix={css(pageDescriptionCss)}>
					How Kody stores your data and what a deployment admin can see.
				</p>
			</header>

			<section mix={css(cardCss)}>
				<h2 mix={css(cardTitleCss)}>What Kody stores per account</h2>
				<p mix={css(descriptionCss)}>
					Each signed-in user gets a fully isolated assistant. Kody stores
					account profile information (email and username), secrets, values,
					memories, packages and their source, jobs, email inboxes and messages,
					chat threads, durable storage, remote connector configuration, OAuth
					grants, and package invocation tokens. All of this is scoped to your
					account and is not shared with other users.
				</p>
			</section>

			<section mix={css(cardCss)}>
				<h2 mix={css(cardTitleCss)}>What a deployment admin can see</h2>
				<p mix={css(descriptionCss)}>
					On shared deployments, operators can grant an admin role for account
					administration. Admins see account metadata only: user id, username,
					email, created and updated timestamps, and role assignments. The admin
					UI lists users and roles; it does not expose user content.
				</p>
			</section>

			<section mix={css(cardCss)}>
				<h2 mix={css(cardTitleCss)}>What an admin can never see</h2>
				<p mix={css(descriptionCss)}>
					The admin role is not a data-access role. Admins cannot see:
				</p>
				<ul mix={css(listCss)}>
					<li>Secret values or secret metadata (names, scopes, allowlists)</li>
					<li>Package invocation tokens</li>
					<li>Values</li>
					<li>Memories</li>
					<li>Packages and their source</li>
					<li>Jobs</li>
					<li>Email inboxes and messages</li>
					<li>Chat threads</li>
					<li>Durable storage contents</li>
					<li>Remote connector configuration</li>
					<li>OAuth grants</li>
				</ul>
				<p mix={css(descriptionCss)}>
					None of this appears in any admin endpoint, page, or API payload — not
					even in redacted or count form.
				</p>
			</section>

			<section mix={css(cardCss)}>
				<h2 mix={css(cardTitleCss)}>Deployment operator access</h2>
				<p mix={css(descriptionCss)}>
					Role-based access controls the application surface. Whoever operates
					the deployment — holding the Cloudflare account, D1 database access,
					and <code>SECRET_STORE_KEY</code> — sits outside any application-level
					control, exactly as before admin roles existed. The admin role grants
					no infrastructure access, and infrastructure access requires no admin
					role.
				</p>
			</section>

			<p mix={css({ margin: 0 })}>
				<a href="/" mix={css(mutedLinkCss)}>
					Back home
				</a>
			</p>
		</section>
	)
}

const pageCss = {
	...stackedPageCss,
	maxWidth: '42rem',
	margin: '0 auto',
}

const listCss = {
	margin: `${spacing.sm} 0 0`,
	paddingLeft: spacing.lg,
	color: colors.text,
	display: 'grid',
	gap: spacing.xs,
	fontSize: typography.fontSize.sm,
	lineHeight: 1.6,
}
