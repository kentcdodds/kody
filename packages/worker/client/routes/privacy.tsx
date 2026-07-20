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
					grants, package invocation tokens, and any platform feedback you
					approve for submission. All of this remains scoped to your account
					except for the narrow admin review of approved platform feedback and
					the community activity metadata described below.
				</p>
			</section>

			<section mix={css(cardCss)}>
				<h2 mix={css(cardTitleCss)}>What a deployment admin can see</h2>
				<p mix={css(descriptionCss)}>
					On shared deployments, operators can grant an admin role for account
					administration. Admins see account metadata only: user id, username,
					email, created and updated timestamps, and role assignments. The admin
					UI lists users and roles; it does not expose account content. Platform
					feedback you explicitly approve for admin review is a narrow
					user-content exception.
				</p>
				<p mix={css(descriptionCss)}>
					Admins also moderate public community listings and attributed
					community reports, and can see who forked or rated a public listing,
					when, and the rating scores. One-click installs appear as forks
					because both use the same activity record. This view and
					admin-configured notifications never include private package source,
					rating notes, email, stable user ids, secrets, or unrelated account
					content.
				</p>
			</section>

			<section mix={css(cardCss)}>
				<h2 mix={css(cardTitleCss)}>Platform feedback</h2>
				<p mix={css(descriptionCss)}>
					An agent may briefly describe Kody friction and ask whether you want
					it submitted. Nothing is submitted unless you explicitly approve.
					Feedback is attributed to your account and is not anonymous. Once you
					approve, the exact approved summary and details and your account user
					id, username, and email may be delivered immediately to admin review
					tools and admin-configured notifications such as Discord. No unrelated
					account content is delivered. Notifications can deep-link an admin to
					the read-only platform-feedback review surface. Admins can read and
					triage only the approved submission, and agents must omit secrets and
					unrelated private content.
				</p>
				<p mix={css(descriptionCss)}>
					Each account can create at most 10 feedback submissions in a rolling
					24-hour period and have at most 100 active submissions (open or
					triaged). Open and triaged feedback remains until it is resolved,
					dismissed, or your account is deleted. Resolved and dismissed feedback
					is removed 365 days after its last update. Your account export
					includes your submissions and their status, but not internal reviewer
					identity, notes, or timestamps. Account deletion removes any remaining
					submissions.
				</p>
				<p mix={css(descriptionCss)}>
					When a notification is still queued, Kody rechecks that the feedback
					exists immediately before delivery and cancels it after account
					deletion when possible. Kody cannot recall a copy already delivered
					outside Kody. Admin notification copies, including Discord messages,
					may remain after Kody account deletion under the deployment
					operator&apos;s retention and deletion controls. Those copies contain
					only the exact approved feedback and its attribution, never unrelated
					account content.
				</p>
			</section>

			<section mix={css(cardCss)}>
				<h2 mix={css(cardTitleCss)}>What an admin can never see</h2>
				<p mix={css(descriptionCss)}>
					The admin role is not a general data-access role. Approving platform
					feedback does not let admins browse:
				</p>
				<ul mix={css(listCss)}>
					<li>Secret values or secret metadata (names, scopes, allowlists)</li>
					<li>Package invocation tokens</li>
					<li>Values</li>
					<li>Memories</li>
					<li>Private packages and their source</li>
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
					control. The admin role grants no infrastructure access, and
					infrastructure access requires no admin role.
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
