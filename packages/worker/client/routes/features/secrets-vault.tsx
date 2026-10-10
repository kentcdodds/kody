import { type Handle, on } from 'remix/component'

export function SecretsVault(handle: Handle) {
	let source: 'saved' | 'vault' = 'saved'
	return () => (
		<section class="story-section">
			<div class="story-split">
				<div class="ms-vault-scene">
					<svg
						class="ms-diagram"
						viewBox="0 0 600 340"
						role="img"
						aria-label="A saved secret or a configured vault provider feeds the same outbound request boundary"
					>
						<rect
							class="ms-paper-back"
							x="20"
							y="58"
							width="226"
							height="211"
							rx="8"
						/>
						<g id="ms-source-drawer">
							<rect
								class="ms-paper"
								x="37"
								y="91"
								width="193"
								height="144"
								rx="4"
							/>
							<circle class="ms-vault-wheel" cx="133" cy="162" r="34" />
							<path class="ms-ink-line" d="M133 129v66m-33-33h66" />
							<text
								x="133"
								y="293"
								text-anchor="middle"
								class="ms-svg-small"
								id="ms-source-label"
							>
								{source === 'vault'
									? 'Configured vault provider'
									: 'Saved in Kody'}
							</text>
						</g>
						<path class="ms-connector" d="M247 162h287m-12-9 12 9-12 9" />
						<rect class="ms-glass" x="342" y="27" width="28" height="261" />
						<text class="ms-svg-small" x="355" y="320" text-anchor="middle">
							Request boundary
						</text>
						<rect
							class="ms-paper"
							x="437"
							y="119"
							width="145"
							height="86"
							rx="4"
						/>
						<text class="ms-svg-small" x="509" y="156" text-anchor="middle">
							Approved API
						</text>
						<text class="ms-svg-small" x="509" y="180" text-anchor="middle">
							receives key
						</text>
					</svg>
					<div class="controls" aria-label="Example credential source">
						<button
							type="button"
							aria-pressed={source === 'saved'}
							mix={on('click', () => {
								source = 'saved'
								handle.update()
							})}
						>
							Saved secret
						</button>
						<button
							type="button"
							aria-pressed={source === 'vault'}
							mix={on('click', () => {
								source = 'vault'
								handle.update()
							})}
						>
							Custom vault provider
						</button>
					</div>
					<p id="ms-source-copy" role="status">
						{source === 'vault'
							? 'A bound provider package retrieves the vault item for the request. Kody core does not connect directly to your vault.'
							: 'The agent uses a reference. Kody adds the credential to the outbound request.'}
					</p>
				</div>
				<div>
					<h2>
						The key can stay
						<br />
						in your vault.
					</h2>
					<p>
						Bind a custom secret provider to use vault items through the same
						request boundary. The agent works with a reference, and the model
						never sees the value.
					</p>
					<p>
						A 1Password provider is one documented example. It needs a
						configured package and an owner-created binding.
					</p>
					<a href="/docs/secret-providers">Set up a secret provider</a>
				</div>
			</div>
			<div class="ms-drafts">
				<div>
					<h3>Let it draft. Keep send out of reach.</h3>
					<p>
						Gmail's draft permission can also send. A drafts-only package, a
						publish lock, and an integration usage lock let your agent prepare
						replies through that package while you review and send in Gmail. The
						token's Google permissions stay the same.
					</p>
					<a href="/docs/locked-gmail-drafts">Build the drafts-only workflow</a>
				</div>
				<svg
					class="ms-diagram"
					viewBox="0 0 430 240"
					role="img"
					aria-label="A draft goes into a review tray while send stays outside the package"
				>
					<path class="ms-paper" d="M73 50h169v106H73z" />
					<path class="ms-ink-line" d="m73 50 85 62 84-62" />
					<path class="ms-tray" d="M38 150h240l-19 50H57z" />
					<text x="158" y="228" text-anchor="middle" class="ms-svg-small">
						Draft ready for your review
					</text>
					<path
						class="ms-ink-line"
						d="m318 52 66 28-66 25 15-26zM350 79v69q0 17 18 17t18-17"
					/>
					<text x="351" y="199" text-anchor="middle" class="ms-svg-small">
						You send
					</text>
				</svg>
			</div>
		</section>
	)
}
