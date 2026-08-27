import { type Handle, css } from 'remix/ui'
import { CopyCodeBlock } from '#client/copy-code-block.tsx'
import {
	highlightSnippetKey,
	type HighlightedCode,
} from '#universal/highlighted-code.ts'
import { type WalkthroughHostPick } from '#universal/walkthrough-hosts.ts'
import {
	howKodyWorksPackageFiles,
	howKodyWorksTranscriptActs,
	transcriptFileLang,
} from './how-kody-works-transcript.ts'
import {
	interactiveGuideActCss,
	interactiveGuideKickerCss,
	interactiveGuideMutedLeadCss,
	interactiveGuideToolBodyCss,
	interactiveGuideToolCss,
	interactiveGuideToolsCss,
	interactiveGuideToolNameCss,
	interactiveGuideToolSummaryCss,
	renderInteractiveGuideWalkthrough,
} from './interactive-guide-walkthrough.tsx'
import {
	renderWalkthroughPackageTitle,
	walkthroughPackageTitleLabel,
} from './walkthrough-ask-kicker.tsx'
import { WalkthroughHostIntro } from './walkthrough-host-intro.tsx'

/**
 * Interactive factory-loop transcript for /guides/how-kody-works.
 * Shared line/tool rendering lives in interactive-guide-walkthrough.tsx.
 * Host selects live in the lead so changing an agent updates the
 * conversation marks and the package-title marks together.
 */
export function HowKodyWorksWalkthrough(
	handle: Handle<{
		highlights?: Record<string, HighlightedCode>
		hosts?: WalkthroughHostPick
	}>,
) {
	let hosts = handle.props.hosts

	return () => {
		if (!hosts && handle.props.hosts) hosts = handle.props.hosts
		return renderInteractiveGuideWalkthrough({
			lead: hosts ? (
				<WalkthroughHostIntro
					hosts={hosts}
					onHostsChange={(next) => {
						hosts = next
						handle.update()
					}}
				/>
			) : (
				'A question you would ask again becomes an export you can invoke from any agent, then a daily email that stays quiet until something actually shipped.'
			),
			acts: howKodyWorksTranscriptActs,
			highlights: handle.props.highlights,
			hosts,
			afterActs: (
				<section
					mix={css(interactiveGuideActCss)}
					aria-labelledby="package-files-title"
				>
					<p mix={css(interactiveGuideKickerCss)}>The package</p>
					<h2
						id="package-files-title"
						aria-label={walkthroughPackageTitleLabel(hosts)}
					>
						{renderWalkthroughPackageTitle(hosts)}
					</h2>
					<p mix={css(interactiveGuideMutedLeadCss)}>
						Same implementation for “ask again” and the morning job. The job
						calls <code>email_send</code> only when the list is not empty.
					</p>
					<div mix={css(interactiveGuideToolsCss)}>
						{(
							Object.entries(howKodyWorksPackageFiles) as Array<
								[keyof typeof howKodyWorksPackageFiles, string]
							>
						).map(([path, code]) => (
							<details key={path} mix={css(interactiveGuideToolCss)}>
								<summary>
									<span mix={css(interactiveGuideToolNameCss)}>{path}</span>
									<span mix={css(interactiveGuideToolSummaryCss)}>
										{packageFileSummary(path)}
									</span>
								</summary>
								<div mix={css(interactiveGuideToolBodyCss)}>
									<CopyCodeBlock
										copy={false}
										code={code}
										lang={transcriptFileLang(path)}
										highlighted={
											handle.props.highlights?.[
												highlightSnippetKey({
													code,
													lang: transcriptFileLang(path),
												})
											]
										}
									/>
								</div>
							</details>
						))}
					</div>
				</section>
			),
		})
	}
}

function packageFileSummary(path: keyof typeof howKodyWorksPackageFiles) {
	switch (path) {
		case 'src/daily-digest.ts':
			return 'Skip mail on a quiet day'
		case 'src/what-shipped.ts':
			return 'Filter public events and advance the cursor'
		case 'package.json':
			return 'Export plus a daily job'
		case 'README.md':
			return 'Why this package exists'
		default: {
			const exhaustive: never = path
			return exhaustive
		}
	}
}
