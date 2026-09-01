import { css, type MixValue } from 'remix/ui'
import { type HighlightedCode } from '#universal/highlighted-code.ts'
import {
	type OnboardingChecklistLoaderData,
	type OnboardingCustomMcpServer,
	type OnboardingFeaturedMcpServer,
} from '#universal/loader-data.ts'
import { type OnboardingFeaturedListing } from '#universal/community-public-types.ts'
import { landingArtAttrs } from '#universal/landing-images.ts'
import { routes } from '#universal/routes.ts'
import { type OnboardingWizardStepNumber } from '#universal/onboarding-process.ts'
import {
	firstInstalledOnboardingExampleName,
	hasInstalledOnboardingExample,
} from '#universal/onboarding-examples.ts'
import {
	firstConnectedOnboardingWorkspaceLabel,
	formatOnboardingFeaturedMcpChoice,
	hasConnectedOnboardingWorkspaceMcp,
	hasPendingOnboardingCustomMcpAuth,
	hasPendingOnboardingFeaturedMcpAuth,
	resolveOnboardingMcpOAuthBanner,
} from '#universal/onboarding-mcp-chooser.ts'
import { buildAuthLink } from '#client/auth-links.ts'
import { OnboardingDiyCard } from '#client/routes/onboarding-diy-card.tsx'
import {
	OnboardingChecklistCard,
	shouldShowOnboardingChecklist,
} from '#client/routes/onboarding-checklist.tsx'
import {
	AgentPickerMark,
	OnboardingMcpClientTabs,
} from '#client/routes/onboarding-mcp-client-tabs.tsx'
import {
	type McpClientKind,
	type OnboardingAgentChooserPick,
	type OnboardingAgentSurface,
	buildOnboardingAgentHref,
	canonicalOnboardingAgentChooser,
} from '#client/routes/onboarding-mcp-clients.ts'
import { OnboardingCustomMcpCard } from '#client/routes/onboarding-custom-mcp-card.tsx'
import { OnboardingMcpChooserCard } from '#client/routes/onboarding-mcp-chooser-card.tsx'
import { OnboardingExampleCard } from '#client/routes/onboarding-example-card.tsx'
import { OnboardingPersistCard } from '#client/routes/onboarding-persist-card.tsx'
import { OnboardingPackageNextSteps } from '#client/routes/onboarding-package-next-steps.tsx'
import { OnboardingStarterCard } from '#client/routes/onboarding-starter-card.tsx'
import {
	Step2ConnectStatus,
	WizardNavigation,
	connectStatusContent,
	connectStatusCss,
	quickExampleDoneCss,
} from '#client/routes/onboarding-wizard-chrome.tsx'
import { colors, radius, typography } from '#universal/styles/tokens.ts'
import {
	getAccentCalloutCss,
	getPillButtonCss,
	primaryLinkCss,
} from '#universal/styles/style-primitives.ts'

type StepNavigationProps = {
	activeStep: OnboardingWizardStepNumber
	onSelectStep: (step: OnboardingWizardStepNumber) => void
}

export function renderConnectAgentPanel(
	props: StepNavigationProps & {
		entrance: MixValue
		loggedIn: boolean
		hasMcpClient: boolean
		selectedAgent: McpClientKind | null
		selectedAgentLabel: string | null
		selectedSurface: OnboardingAgentSurface
		agentChooser: OnboardingAgentChooserPick | null
		mcpServerUrl: string
		mcpHighlights: Record<string, HighlightedCode>
		agentLocation: { pathname: string; search: string; hash: string }
	},
) {
	return (
		<section
			id="connect-agent"
			aria-labelledby="connect-title"
			data-testid="onboarding-connect-agent"
			mix={[css(wizardPanelCss), props.entrance]}
		>
			<div mix={css(panelHeadCss)}>
				<div>
					<p mix={css(panelKickerCss)}>Step 1</p>
					<div mix={css(panelTitleRowCss)}>
						<h2 id="connect-title" tabIndex={-1} mix={css(panelTitleCss)}>
							{props.selectedAgentLabel
								? `Connect ${props.selectedAgentLabel}`
								: 'Connect your agent'}
						</h2>
						{props.selectedAgent ? (
							<AgentPickerMark
								agent={props.selectedAgent}
								surface={props.selectedSurface}
								testId="onboarding-agent-title-mark"
							/>
						) : null}
					</div>
					{props.selectedAgent ? (
						<a
							href={buildOnboardingAgentHref({
								...props.agentLocation,
								agent: null,
							})}
							data-testid="onboarding-agent-change"
							data-prevent-scroll-reset=""
							mix={css(changeSelectionCss)}
						>
							Change selection
						</a>
					) : null}
				</div>
				<img
					data-panel-art
					src="/images/kody-mcp-plug.webp"
					width={627}
					height={627}
					loading="lazy"
					alt="Kody plugging a cable into a warmly glowing port on a laptop"
					style={{ '--tilt': '2deg' }}
					mix={css(panelArtCss)}
				/>
			</div>
			{renderConnectAgentStatus(props)}
			<OnboardingMcpClientTabs
				mcpServerUrl={props.mcpServerUrl}
				highlights={props.mcpHighlights}
				selectedAgent={props.selectedAgent}
				surface={props.selectedSurface}
				chooser={props.agentChooser ?? canonicalOnboardingAgentChooser()}
				agentLocation={props.agentLocation}
			/>
			<WizardNavigation
				activeStep={props.activeStep}
				onSelectStep={props.onSelectStep}
				confirmUnconnectedNext={!props.hasMcpClient}
			/>
		</section>
	)
}

function renderConnectAgentStatus(props: {
	loggedIn: boolean
	hasMcpClient: boolean
	selectedAgent: McpClientKind | null
	selectedAgentLabel: string | null
	selectedSurface: OnboardingAgentSurface
	agentLocation: { pathname: string; search: string; hash: string }
}) {
	if (props.hasMcpClient) {
		return (
			<div
				mix={css(connectStatusCss)}
				role="status"
				aria-live="polite"
				data-connected="true"
			>
				{connectStatusContent({
					connected: true,
					connectedLabel: props.selectedAgentLabel
						? `${props.selectedAgentLabel} is connected`
						: 'You are connected',
					waitingLabel: 'Waiting for your agent to connect…',
				})}
			</div>
		)
	}
	if (!props.selectedAgent) return null
	if (!props.loggedIn) {
		const resumeHref = buildOnboardingAgentHref({
			...props.agentLocation,
			agent: props.selectedAgent,
			surface: props.selectedSurface,
		})
		return (
			<a
				href={buildAuthLink(routes.login.href(), resumeHref)}
				data-testid="onboarding-agent-login"
				mix={css(agentLoginCss)}
			>
				{props.selectedAgentLabel
					? `Log in to connect ${props.selectedAgentLabel}`
					: 'Log in to connect'}
			</a>
		)
	}
	return (
		<div mix={css(connectStatusCss)} role="status" aria-live="polite">
			{connectStatusContent({
				connected: false,
				connectedLabel: 'You are connected',
				waitingLabel: props.selectedAgentLabel
					? `Waiting for ${props.selectedAgentLabel} to connect…`
					: 'Waiting for your agent to connect…',
			})}
		</div>
	)
}

export function renderAccessPanel(
	props: StepNavigationProps & {
		entrance: MixValue
		loggedIn: boolean
		username: string | null
		hasStep2Win: boolean
		awaitingMcpConnection: boolean
		oauthReturnSucceeded: boolean
		oauthReturnError: string | null
		urlOauthError: string | null
		featuredMcpServers: Array<OnboardingFeaturedMcpServer>
		customMcpServers: Array<OnboardingCustomMcpServer>
		exampleListings: Array<OnboardingFeaturedListing>
		onChanged: () => void
		onAuthStarted: () => void
	},
) {
	return (
		<section
			id="connect-mcp"
			aria-labelledby="connect-mcp-title"
			data-testid="onboarding-connect-mcp"
			mix={[css(wizardPanelCss), props.entrance]}
		>
			<div mix={css(panelHeadCss)}>
				<div>
					<p mix={css(panelKickerCss)}>Step 2</p>
					<h2 id="connect-mcp-title" tabIndex={-1} mix={css(panelTitleCss)}>
						Give Kody Access
					</h2>
				</div>
				<img
					data-panel-art
					{...landingArtAttrs('kody-community-packages')}
					width={627}
					height={627}
					alt="Kody kneeling beside a stack of parcels, one open and glowing with a eucalyptus sprig"
					style={{ '--tilt': '1.5deg' }}
					mix={css(panelArtCss)}
				/>
			</div>
			<p mix={css(panelLedeCss)}>
				Give Kody access to your stuff. Official one-click login is the easy
				path: add {formatOnboardingFeaturedMcpChoice()} and authorize it.
				Connect also copies the matching official helper into your account. None
				of these? Add another server, or just try Kody without a third-party
				login.
			</p>
			<ul mix={css(starterGridCss)} data-testid="onboarding-mcp-chooser">
				{props.featuredMcpServers.map((server) => (
					<OnboardingMcpChooserCard
						key={server.id}
						server={server}
						loggedIn={props.loggedIn}
						onChanged={props.onChanged}
						onAuthStarted={props.onAuthStarted}
					/>
				))}
			</ul>
			<Step2ConnectStatus
				waiting={
					props.awaitingMcpConnection ||
					hasPendingOnboardingFeaturedMcpAuth(props.featuredMcpServers) ||
					hasPendingOnboardingCustomMcpAuth(props.customMcpServers)
				}
				connected={hasConnectedOnboardingWorkspaceMcp({
					featuredMcpServers: props.featuredMcpServers,
					customMcpServers: props.customMcpServers,
				})}
				exampleInstalled={hasInstalledOnboardingExample(props.exampleListings)}
				oauthError={resolveOnboardingMcpOAuthBanner({
					connected: hasConnectedOnboardingWorkspaceMcp({
						featuredMcpServers: props.featuredMcpServers,
						customMcpServers: props.customMcpServers,
					}),
					returnedSuccess: props.oauthReturnSucceeded,
					returnedError: props.oauthReturnError,
					urlError: props.urlOauthError,
				})}
				onNext={() => props.onSelectStep(3)}
			/>
			<aside
				aria-label="How it works"
				mix={css(howItWorksCss)}
				data-testid="onboarding-how-it-works"
			>
				<p mix={css(howItWorksLabelCss)}>How it works</p>
				<p>
					Connect adds the official login, copies the matching helper into your
					account, and opens the provider authorize page. Approve access, then
					your agent can use those tools. You run the copy in your account —
					official <em>@kody</em> listings are a catalog, not something a person
					account invokes live.
				</p>
			</aside>
			<div mix={css(step2ExitCss)} data-testid="onboarding-none-of-these">
				<p mix={css(step2ExitLabelCss)}>None of these?</p>
				<p mix={css(step2ExitLedeCss)}>
					Add any remote MCP server. Same easy authorize path — just not a
					vendor we featured.
				</p>
				<OnboardingCustomMcpCard
					servers={props.customMcpServers}
					loggedIn={props.loggedIn}
					onChanged={props.onChanged}
					onAuthStarted={props.onAuthStarted}
				/>
			</div>
			<div mix={css(step2ExitCss)} data-testid="onboarding-advanced">
				<p mix={css(step2ExitLabelCss)}>Advanced</p>
				<p mix={css(step2ExitLedeCss)}>
					No one-click login for that service? Follow a provider guide — GitHub
					and Google are the usual next ones — or bring your own keys after the
					first build.
				</p>
				<p mix={css(step2ExitLedeCss)}>
					<a href="/guides/github" mix={css(primaryLinkCss)}>
						Connect GitHub
					</a>
					{' · '}
					<a href="/guides/google" mix={css(primaryLinkCss)}>
						Connect Google
					</a>
					{' · '}
					<a href="/account/secrets/new" mix={css(primaryLinkCss)}>
						Account → Secrets
					</a>
					{' · '}
					<a href="/#byok-title" mix={css(primaryLinkCss)}>
						Why bring your own keys?
					</a>
				</p>
			</div>
			{props.exampleListings.length > 0 ? (
				<div mix={css(step2ExitCss)} data-testid="onboarding-just-try">
					<p mix={css(step2ExitLabelCss)}>Just try Kody</p>
					<p mix={css(step2ExitLedeCss)}>
						No third-party login. Install an example, then persist it as a
						package you own.
					</p>
					<ul
						mix={css(starterGridCss)}
						data-testid="onboarding-example-packages"
					>
						{props.exampleListings.map((listing) => (
							<OnboardingExampleCard
								key={listing.id}
								listing={listing}
								loggedIn={props.loggedIn}
								username={props.username}
								onInstalled={props.onChanged}
							/>
						))}
					</ul>
				</div>
			) : null}
			<WizardNavigation
				activeStep={props.activeStep}
				onSelectStep={props.onSelectStep}
				confirmUnconnectedNext={!props.hasStep2Win}
				skipLabel="Skip for now"
				onSkip={() => props.onSelectStep(3)}
			/>
		</section>
	)
}

export function renderPersistPanel(
	props: StepNavigationProps & {
		entrance: MixValue
		loggedIn: boolean
		setupPrompt: string
		persistPrompt: string
		hasPersistedPackage: boolean
		persistedPackageKodyId: string | null
		ownedExampleKodyId: string
		featuredMcpServers: Array<OnboardingFeaturedMcpServer>
		customMcpServers: Array<OnboardingCustomMcpServer>
		exampleListings: Array<OnboardingFeaturedListing>
		serviceStarterListings: Array<OnboardingFeaturedListing>
		checklist: OnboardingChecklistLoaderData | null
		checklistHidden: boolean
		onChecklistDismissed: () => void
	},
) {
	const workspaceLabel = firstConnectedOnboardingWorkspaceLabel({
		featuredMcpServers: props.featuredMcpServers,
		customMcpServers: props.customMcpServers,
	})
	const exampleName = firstInstalledOnboardingExampleName(props.exampleListings)
	const persistTargetLabel = workspaceLabel ?? exampleName
	return (
		<section
			id="first-build"
			aria-labelledby="first-build-title"
			data-testid="onboarding-first-build"
			mix={[css(wizardPanelCss), props.entrance]}
		>
			<div mix={css(panelHeadCss)}>
				<div>
					<p mix={css(panelKickerCss)}>Step 3</p>
					<h2 id="first-build-title" tabIndex={-1} mix={css(panelTitleCss)}>
						Try it, then persist
					</h2>
				</div>
				<img
					data-panel-art
					{...landingArtAttrs('kody-greeting')}
					width={627}
					height={627}
					alt="Kody waving beside a warm envelope"
					style={{ '--tilt': '-1.5deg' }}
					mix={css(panelArtCss)}
				/>
			</div>
			<p mix={css(panelLedeCss)}>
				This is the permanence lesson: run one useful ad hoc request
				{persistTargetLabel ? ` against ${persistTargetLabel}` : ''}, then save
				that working code as a package you own.
			</p>
			<OnboardingPersistCard
				persistPrompt={props.persistPrompt}
				connectedServerLabel={workspaceLabel}
				installedExampleName={exampleName}
			/>
			{props.hasPersistedPackage ? (
				<>
					<p
						mix={css(quickExampleDoneCss)}
						data-testid="onboarding-first-build-done"
					>
						Done — you have a package in your account. Keep editing it, or start
						another.
					</p>
					<OnboardingPackageNextSteps
						kodyId={props.persistedPackageKodyId ?? props.ownedExampleKodyId}
						source={props.persistedPackageKodyId ? 'persist' : 'fork'}
					/>
				</>
			) : null}
			<aside
				aria-label="How it works"
				mix={css(howItWorksCss)}
				data-testid="onboarding-persist-how-it-works"
			>
				<p mix={css(howItWorksLabelCss)}>How it works</p>
				<p>
					Paste the prompt into your connected agent. It runs one{' '}
					<em>execute</em> call, shows the result, then persists that working
					code with <em>packageSave</em>. That owned package is the point of
					Kody.
				</p>
			</aside>
			<div mix={css(advancedSectionCss)}>
				<p mix={css(advancedLabelCss)}>
					More ways to connect
					<span mix={css(advancedBadgeCss)}>Advanced</span>
				</p>
				<p mix={css(advancedLedeCss)}>
					Featured starters stay available after the first build. Prefer your
					own keys for full control.
				</p>
				<ul mix={css(starterListCss)}>
					{props.serviceStarterListings.map((listing) => (
						<OnboardingStarterCard
							key={listing.id}
							listing={listing}
							loggedIn={props.loggedIn}
							variant="row"
						/>
					))}
					<OnboardingDiyCard setupPrompt={props.setupPrompt} variant="row" />
				</ul>
				<p mix={css({ margin: '0.2rem 0 0' })}>
					<a
						href="/community"
						target="_blank"
						rel="noreferrer noopener"
						mix={css(primaryLinkCss)}
					>
						Browse all public packages
					</a>
				</p>
			</div>
			{shouldShowOnboardingChecklist(props.checklist) &&
			!props.checklistHidden ? (
				<OnboardingChecklistCard
					checklist={props.checklist!}
					onDismissed={props.onChecklistDismissed}
				/>
			) : null}
			<WizardNavigation
				activeStep={props.activeStep}
				onSelectStep={props.onSelectStep}
			/>
		</section>
	)
}

/* One panel at a time: a card that holds the whole step. */
const wizardPanelCss = {
	marginTop: '1rem',
	backgroundColor: colors.surface,
	border: `1.5px solid ${colors.border}`,
	borderRadius: radius.card,
	padding: 'clamp(1.4rem, 3.5vw, 2.2rem)',
	display: 'grid',
	gap: '1.15rem',
	/*
	 * Grid items floor at min-content, so one unbreakable child (a long URL, a
	 * wide code sample) would otherwise widen the whole panel and the page with
	 * it. Keep the column free to shrink and let the child wrap instead.
	 */
	minWidth: 0,
	'& > *': { minWidth: 0 },
}

const panelHeadCss = {
	display: 'flex',
	justifyContent: 'space-between',
	alignItems: 'center',
	gap: '1rem',
	'@media (max-width: 720px)': {
		flexDirection: 'column-reverse' as const,
		alignItems: 'flex-start',
	},
}

const panelKickerCss = {
	margin: '0 0 0.35rem',
	font: `700 0.78rem/1 ${typography.fontFamilyDisplay}`,
	textTransform: 'uppercase' as const,
	letterSpacing: '0.09em',
	color: colors.primaryText,
}

const panelTitleRowCss = {
	display: 'flex',
	alignItems: 'center',
	gap: '0.65rem',
	flexWrap: 'wrap' as const,
}

const panelTitleCss = {
	margin: 0,
	fontSize: 'clamp(1.4rem, 2.4vw, 1.75rem)',
	fontWeight: 720,
	letterSpacing: '-0.018em',
	lineHeight: 1.15,
}

const changeSelectionCss = {
	...primaryLinkCss,
	display: 'inline-block',
	marginTop: '0.35rem',
	fontSize: typography.fontSize.sm,
}

const agentLoginCss = {
	...getPillButtonCss({ size: 'sm' }),
	width: 'fit-content',
}

/* Placed by hand, not stamped by a grid. */
const panelArtCss = {
	flex: 'none',
	width: 'clamp(90px, 11vw, 130px)',
	height: 'auto',
	rotate: 'var(--tilt, 0deg)',
	margin: '-0.4rem 0 -1.4rem',
	'@media (max-width: 720px)': {
		width: 'min(34%, 130px)',
		margin: '-0.4rem 0 0',
		alignSelf: 'flex-end',
	},
}

const panelLedeCss = {
	margin: 0,
	color: colors.textMuted,
	maxWidth: '68ch',
}

/* The "learn" half lives here, labeled and out of the instructions' way. */
const howItWorksCss = {
	...getAccentCalloutCss(),
	'& p': {
		margin: 0,
		color: colors.textMuted,
		fontSize: '0.92rem',
		lineHeight: 1.55,
	},
	'& em': {
		fontStyle: 'normal',
		fontWeight: 650,
		color: colors.text,
	},
}

const howItWorksLabelCss = {
	font: `700 0.78rem/1 ${typography.fontFamilyBody}`,
	letterSpacing: '0.06em',
	textTransform: 'uppercase' as const,
	color: colors.primaryText,
}

const step2ExitCss = {
	display: 'grid',
	gap: '0.45rem',
	marginTop: '0.35rem',
	paddingTop: '1rem',
	borderTop: `1px solid ${colors.border}`,
}

const step2ExitLabelCss = {
	margin: 0,
	font: `700 0.78rem/1 ${typography.fontFamilyBody}`,
	letterSpacing: '0.06em',
	textTransform: 'uppercase' as const,
	color: colors.textMuted,
}

const step2ExitLedeCss = {
	margin: 0,
	color: colors.textMuted,
	fontSize: '0.92rem',
	lineHeight: 1.55,
	maxWidth: '68ch',
}

/* Featured starters demote to Advanced under the persist lead. */
const advancedSectionCss = {
	display: 'grid',
	gap: '0.55rem',
	marginTop: '0.6rem',
	paddingTop: '1.1rem',
	borderTop: `1px solid ${colors.border}`,
}

const advancedLabelCss = {
	margin: 0,
	display: 'flex',
	alignItems: 'center',
	gap: '0.5rem',
	font: `700 0.78rem/1 ${typography.fontFamilyBody}`,
	letterSpacing: '0.06em',
	textTransform: 'uppercase' as const,
	color: colors.textMuted,
}

const advancedBadgeCss = {
	display: 'inline-block',
	padding: '0.18rem 0.5rem',
	borderRadius: radius.full,
	border: `1px solid ${colors.border}`,
	backgroundColor: colors.surface,
	font: `700 0.68rem/1 ${typography.fontFamilyBody}`,
	letterSpacing: '0.06em',
	color: colors.textMuted,
}

const advancedLedeCss = {
	margin: 0,
	color: colors.textMuted,
	fontSize: '0.92rem',
	lineHeight: 1.55,
	maxWidth: '68ch',
}

const starterListCss = {
	listStyle: 'none',
	margin: '0.2rem 0 0',
	padding: 0,
	display: 'grid',
	gap: '0.6rem',
}

/* Starter packages: compact centered cards; the DIY card breaks the grid
   with a dashed border so "no package" reads as a real option. */
const starterGridCss = {
	listStyle: 'none',
	margin: '0.2rem 0 0',
	padding: 0,
	display: 'grid',
	gridTemplateColumns: 'repeat(auto-fill, minmax(min(12.5rem, 100%), 1fr))',
	gap: '0.9rem',
}
