import { css } from 'remix/ui'
import { CopyCodeBlock } from '#client/copy-code-block.tsx'
import {
	howKodyWorksPackageFiles,
	howKodyWorksTranscriptActs,
} from './how-kody-works-transcript.ts'
import {
	interactiveGuideActCss,
	interactiveGuideKickerCss,
	interactiveGuideMutedLeadCss,
	interactiveGuideToolBodyCss,
	interactiveGuideToolCss,
	interactiveGuideToolNameCss,
	interactiveGuideToolSummaryCss,
	renderInteractiveGuideWalkthrough,
} from './interactive-guide-walkthrough.tsx'

/**
 * Interactive factory-loop transcript for /guides/how-kody-works.
 * Shared line/tool rendering lives in interactive-guide-walkthrough.tsx.
 */
export function renderHowKodyWorksWalkthrough() {
	return renderInteractiveGuideWalkthrough({
		lead: 'A question you would ask again becomes an export you can invoke from any agent, then a daily email that stays quiet until something actually shipped.',
		acts: howKodyWorksTranscriptActs,
		afterActs: (
			<section
				mix={css(interactiveGuideActCss)}
				aria-labelledby="package-files-title"
			>
				<p mix={css(interactiveGuideKickerCss)}>The package</p>
				<h2 id="package-files-title">What the agent wrote</h2>
				<p mix={css(interactiveGuideMutedLeadCss)}>
					Same implementation for “ask again” and the morning job. The job calls{' '}
					<code>email_send</code> only when the list is not empty.
				</p>
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
								lang={
									path.endsWith('.ts')
										? 'ts'
										: path.endsWith('.json')
											? 'json'
											: 'md'
								}
							/>
						</div>
					</details>
				))}
			</section>
		),
	})
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
