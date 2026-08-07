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
					What Kody collects, why it is needed, and the choices you have.
				</p>
			</header>

			<section mix={css(cardCss)}>
				<h2 mix={css(cardTitleCss)}>Who is responsible for your data</h2>
				<p mix={css(descriptionCss)}>
					Kent C. Dodds, operator of Kody at heykody.app, is the data controller
					for the hosted service. You can reach the operator at{' '}
					<a href="mailto:support@heykody.dev" mix={css(mutedLinkCss)}>
						support@heykody.dev
					</a>
					. A separately operated Kody deployment has its own operator and data
					controller.
				</p>
			</section>

			<section mix={css(cardCss)}>
				<h2 mix={css(cardTitleCss)}>What Kody stores per account</h2>
				<p mix={css(descriptionCss)}>
					Each signed-in user gets a fully isolated assistant. Kody stores
					account profile information (email and username), secrets, values,
					memories, packages and their source, jobs, email inboxes and messages,
					durable storage, remote connector configuration, OAuth grants, package
					invocation tokens, and any platform feedback you approve for
					submission. All of this remains scoped to your account except for the
					narrow admin review of approved platform feedback and the community
					activity metadata described below.
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
					<li>Durable storage contents</li>
					<li>Remote connector configuration</li>
					<li>OAuth grants</li>
				</ul>
				<p mix={css(descriptionCss)}>
					None of this appears in any admin endpoint, page, or API payload — not
					even in redacted or count form — with one qualified exception:
					platform maintenance codemods, described next, surface package
					identity, affected file paths, and fixed migration messages (never
					file contents).
				</p>
			</section>

			<section mix={css(cardCss)}>
				<h2 mix={css(cardTitleCss)}>Platform maintenance (package codemods)</h2>
				<p mix={css(descriptionCss)}>
					When the platform&apos;s package API changes, Kody migrates published
					package source with package codemods: versioned, deterministic
					transforms that live in the open-source repository and ship through
					code review like any other platform change. Nobody can author an ad
					hoc transform through the admin surface — admins only choose when a
					published, reviewed codemod runs, and can scope it to a dry run first.
				</p>
				<p mix={css(descriptionCss)}>
					A codemod apply rewrites only what the reviewed transform matches,
					republishes the package through the same checks as a normal publish,
					records a <code>codemod(&lt;id&gt;)</code> commit in the
					package&apos;s own git history, keeps a revert snapshot, and
					dispatches a <code>package.codemod.applied</code> (or{' '}
					<code>.reverted</code>) event your packages can subscribe to. Fleet
					runs are audit-logged.
				</p>
				<p mix={css(descriptionCss)}>
					Running a codemod never shows an admin your source. Scan and run
					results expose only package identity (ids), affected file paths, and
					the codemod&apos;s own fixed finding messages — codemods are forbidden
					from embedding file contents in their findings. Ambiguous matches are
					skipped and reported for the owner rather than rewritten.
				</p>
			</section>

			<section mix={css(cardCss)}>
				<h2 mix={css(cardTitleCss)}>How long Kody keeps data</h2>
				<p mix={css(descriptionCss)}>
					Account content such as packages, secrets, values, memories, jobs, and
					durable storage remains available while your account and that content
					exist. You can delete individual content or the whole account. Some
					operational records have fixed cleanup periods:
				</p>
				<ul mix={css(listCss)}>
					<li>Email delivery events: 90 days</li>
					<li>Email messages and their attachments: 365 days</li>
					<li>
						Completed workflow runs and conversation-suppression records: 90
						days
					</li>
					<li>
						Resolved or dismissed platform feedback: 365 days after its last
						update; open or triaged feedback remains until it is resolved,
						dismissed, or the account is deleted
					</li>
					<li>Audit events: 180 days</li>
					<li>Feature-flag exposure records: 90 days</li>
					<li>Daily entitlement counters: 400 days</li>
					<li>Monthly usage rollups: 24 months</li>
					<li>Stripe webhook event records: 30 days</li>
					<li>
						Non-current published bundle artifacts: at least 30 days, then
						eligible for removal when no active source or repo session needs
						them
					</li>
				</ul>
				<p mix={css(descriptionCss)}>
					Deletion from a subprocessor&apos;s backups or logs follows that
					subprocessor&apos;s own retention cycle. Records may be kept longer
					when required by law, needed to resolve a dispute, or necessary to
					protect the service from abuse.
				</p>
			</section>

			<section mix={css(cardCss)}>
				<h2 mix={css(cardTitleCss)}>Service providers</h2>
				<p mix={css(descriptionCss)}>
					Kody uses these subprocessors to run the hosted service. They process
					only the data needed for their role:
				</p>
				<ul mix={css(listCss)}>
					<li>
						Cloudflare — application hosting, database, object storage, email
						delivery, security, and network infrastructure
					</li>
					<li>Stripe — paid subscriptions, billing, and payment records</li>
					<li>
						Kit — waitlist and product email subscriptions when you submit your
						email for those purposes
					</li>
					<li>
						Sentry — application error reporting and operational diagnostics
					</li>
					<li>Fathom — privacy-focused website traffic analytics</li>
				</ul>
			</section>

			<section mix={css(cardCss)}>
				<h2 mix={css(cardTitleCss)}>Your choices and rights</h2>
				<p mix={css(descriptionCss)}>
					Use Account settings to export a copy of your Kody data or delete your
					account. You can also ask to access, correct, delete, restrict, or
					receive your personal data, or object to its processing, by emailing{' '}
					<a href="mailto:support@heykody.dev" mix={css(mutedLinkCss)}>
						support@heykody.dev
					</a>
					. Which rights apply depends on where you live. We may need to verify
					your identity before acting on a request.
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
				<a href="/pricing" mix={css(mutedLinkCss)}>
					Pricing
				</a>
				{' · '}
				<a href="/terms" mix={css(mutedLinkCss)}>
					Terms
				</a>
				{' · '}
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
