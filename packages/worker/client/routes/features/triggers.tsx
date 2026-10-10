import { on, type Handle } from 'remix/component'
import { BuildWithAgentButton } from '#client/build-with-agent-button.tsx'
import { TriggerSignalsArt, TriggerScanArt } from './triggers-art.tsx'
import { triggerExamples, signals } from './triggers-data.ts'

export function TriggersFeature(handle: Handle) {
	let selected: keyof typeof triggerExamples = 'purchase'
	let signal: keyof typeof signals = 'webhook'
	let ran = false
	let otherAddress = false
	let showFlake = false
	let scanFlake = false
	let scanResult = ''
	return () => {
		const event = triggerExamples[selected]
		const result =
			selected === 'email' && otherAddress
				? 'No matching tag. No action.'
				: selected === 'schedule' && showFlake
					? 'Investigation started'
					: event.result
		const detail =
			selected === 'email' && otherAddress
				? 'No matching tag. No handler started.'
				: selected === 'schedule' && showFlake
					? 'Agent called after the scan found a signal.'
					: event.detail
		return (
			<div class="study triggers">
				<img
					class="feature-orb"
					src="/images/lantern/kody-primitives-orb-triggers.webp"
					alt=""
					width="80"
					height="80"
				/>
				<h1>
					Give the next step
					<br />a starting signal.
				</h1>
				<p class="lead">
					A purchase lands. An issue opens. An email arrives. Your package runs,
					even when the chat is closed.
				</p>
				<a class="action" href="/onboarding">
					Connect your agent
				</a>
				<div class="controls" aria-label="Example trigger">
					<button
						type="button"
						aria-pressed={selected === 'purchase'}
						mix={on('click', () => {
							selected = 'purchase'
							ran = false
							handle.update()
						})}
					>
						A purchase
					</button>
					<button
						type="button"
						aria-pressed={selected === 'issue'}
						mix={on('click', () => {
							selected = 'issue'
							ran = false
							handle.update()
						})}
					>
						An issue
					</button>
					<button
						type="button"
						aria-pressed={selected === 'email'}
						mix={on('click', () => {
							selected = 'email'
							ran = false
							handle.update()
						})}
					>
						An email
					</button>
					<button
						type="button"
						aria-pressed={selected === 'schedule'}
						mix={on('click', () => {
							selected = 'schedule'
							ran = false
							handle.update()
						})}
					>
						A daily check
					</button>
				</div>
				<div class="ledger ui-stage">
					<div class="ui-window">
						<small>
							<span class="ui-symbol">↗</span> When
						</small>
						<strong>{event.when}</strong>
					</div>
					<div class="ui-window">
						<small>
							<span class="ui-symbol">ƒ</span> Run package
						</small>
						<strong>{event.package}</strong>
					</div>
					<div class="ui-window">
						<small>
							<span class="ui-symbol">✓</span> Result
						</small>
						<strong>{result}</strong>
						<p class="result" id="trigger-detail" aria-live="polite">
							{ran ? detail : 'Run the example to follow the event.'}
						</p>
					</div>
				</div>
				<div class="controls">
					{selected === 'email' && (
						<label>
							<input
								type="checkbox"
								checked={otherAddress}
								mix={on('change', (event) => {
									otherAddress = event.currentTarget.checked
									ran = false
									handle.update()
								})}
							/>{' '}
							Use another address
						</label>
					)}
					{selected === 'schedule' && (
						<label>
							<input
								type="checkbox"
								checked={showFlake}
								mix={on('change', (event) => {
									showFlake = event.currentTarget.checked
									ran = false
									handle.update()
								})}
							/>{' '}
							Show a flake
						</label>
					)}
					<button
						type="button"
						class="run"
						mix={on('click', () => {
							ran = true
							handle.update()
						})}
					>
						Run example
					</button>
				</div>
				<p class="smallprint">
					Illustrative events. Ordinary code can do the watching and call an
					agent when needed.
				</p>
				<section class="story-section story-split pt-signals">
					<div>
						<h2>
							Use the signal
							<br />
							you already have.
						</h2>
						<p>
							Your tools, inbox, packages, and schedule can each start the next
							piece of work.
						</p>
						<div class="pt-signal-list" aria-label="Starting signal">
							<button
								type="button"
								aria-pressed={signal === 'webhook'}
								mix={on('click', () => {
									signal = 'webhook'
									handle.update()
								})}
							>
								<strong>Your tools can call it.</strong>
								<span>A system sends a webhook.</span>
							</button>
							<button
								type="button"
								aria-pressed={signal === 'inbox'}
								mix={on('click', () => {
									signal = 'inbox'
									handle.update()
								})}
							>
								<strong>Your inbox can start it.</strong>
								<span>Route mail by sender or plus-tag.</span>
							</button>
							<button
								type="button"
								aria-pressed={signal === 'package'}
								mix={on('click', () => {
									signal = 'package'
									handle.update()
								})}
							>
								<strong>Your packages can pass it on.</strong>
								<span>React to an event in your account.</span>
							</button>
							<button
								type="button"
								aria-pressed={signal === 'clock'}
								mix={on('click', () => {
									signal = 'clock'
									handle.update()
								})}
							>
								<strong>The clock works too.</strong>
								<span>Run on a schedule or later.</span>
							</button>
						</div>
						<a href="/docs/triggers">Read the trigger guide ↗</a>
					</div>
					<div class="pt-switch-illustration">
						<TriggerSignalsArt signal={signal} />
						<div class="pt-signal-outcome" aria-live="polite">
							<strong>{signals[signal].name}</strong>
							<p id="pt-signal-detail">{signals[signal].detail}</p>
							<a href={signals[signal].href}>How this signal works ↗</a>
						</div>
					</div>
				</section>
				<section class="story-section story-split pt-watching">
					<div>
						<h2>
							Let code do
							<br />
							the watching.
						</h2>
						<p>
							A trigger starts your package without a model deciding whether to
							run it. The package can call an agent when the work needs one.
						</p>
						<div class="pt-options">
							<label>
								<input
									type="checkbox"
									checked={scanFlake}
									mix={on('change', (event) => {
										scanFlake = event.currentTarget.checked
										handle.update()
									})}
								/>{' '}
								Include a flaky test in this example
							</label>
							<button
								type="button"
								mix={on('click', () => {
									scanResult = scanFlake ? 'flake' : 'clean'
									handle.update()
								})}
							>
								Run example scan
							</button>
						</div>
						<p id="pt-scan-result" class="pt-status" aria-live="polite">
							{scanResult === 'flake'
								? 'Flake found. The example package calls an agent to investigate.'
								: scanResult === 'clean'
									? 'Scan complete. No flakes found, no agent called, no notification.'
									: 'A clean scan can end with no notification.'}
						</p>
						<a href="/docs/flake-hunter">See how Flake Hunter works ↗</a>
					</div>
					<div class="pt-decision" data-result={scanResult}>
						<TriggerScanArt />
						<p class="pt-example-caption">
							Example scan. An agent is called only on the branch that needs
							investigation.
						</p>
					</div>
				</section>
				<div class="feature-start">
					<div>
						<h2>Test it before you leave it running.</h2>
						<p>
							Run the handler once and check the result. Follow recent runs and
							failures in Activity.
						</p>
						<p>
							<a href="/docs/triggers">Read the guide</a>
						</p>
					</div>
					<div class="controls">
						<a class="action" href="/onboarding">
							Connect your agent
						</a>
						<BuildWithAgentButton />
					</div>
				</div>
			</div>
		)
	}
}
