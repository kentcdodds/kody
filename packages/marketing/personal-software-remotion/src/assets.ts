import bricolageLatin from '../../../worker/public/fonts/bricolage-grotesque-latin.woff2'
import wixLatin from '../../../worker/public/fonts/wix-madefor-text-latin.woff2'
import chatgptMark from '../../../worker/public/images/icons/chatgpt.svg'
import claudeMark from '../../../worker/public/images/icons/claude.svg'
import codexMark from '../../../worker/public/images/icons/codex.svg'
import cursorMark from '../../../worker/public/images/icons/cursor.svg'
import geminiMark from '../../../worker/public/images/icons/gemini.svg'
import githubMark from '../../../worker/public/images/icons/github.svg'
import linearMark from '../../../worker/public/images/icons/linear.svg'
import slackMark from '../../../worker/public/images/icons/slack.svg'
import spotifyMark from '../../../worker/public/images/icons/spotify.svg'
import stripeMark from '../../../worker/public/images/icons/stripe.svg'
import appsOrb from '../../../worker/public/images/lantern/kody-primitives-orb-apps.webp'
import integrationsOrb from '../../../worker/public/images/lantern/kody-primitives-orb-integrations.webp'
import memoryOrb from '../../../worker/public/images/lantern/kody-primitives-orb-memory.webp'
import packagesOrb from '../../../worker/public/images/lantern/kody-primitives-orb-packages.webp'
import secretsOrb from '../../../worker/public/images/lantern/kody-primitives-orb-secrets.webp'
import triggersOrb from '../../../worker/public/images/lantern/kody-primitives-orb-triggers.webp'
import lanternStill from '../../../worker/public/images/lantern/kody-primitives-lantern.webp'
import kodyLogo from '../../../worker/public/logo-240.webp'
import kodyPattern from '../../../worker/public/images/kody-pattern.webp'
import { type LandingPrimitiveId } from '../../../worker/universal/landing-lantern.ts'

/**
 * Product art comes straight from the app's public folder so the video
 * never drifts from what kody.codes ships.
 */
export const fontFiles = { bricolageLatin, wixLatin }

export const lanternArt = {
	still: lanternStill,
	width: 863,
	height: 1242,
} as const

export const orbArt = {
	memory: memoryOrb,
	secrets: secretsOrb,
	packages: packagesOrb,
	triggers: triggersOrb,
	integrations: integrationsOrb,
	apps: appsOrb,
} as const satisfies Record<LandingPrimitiveId, string>

export const brandArt = { kodyLogo, kodyPattern }

export const markFiles = {
	github: githubMark,
	stripe: stripeMark,
	slack: slackMark,
	linear: linearMark,
	spotify: spotifyMark,
	cursor: cursorMark,
	claude: claudeMark,
	chatgpt: chatgptMark,
	codex: codexMark,
	gemini: geminiMark,
} as const
