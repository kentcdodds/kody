import { type Handle, css, on } from 'remix/component'
import { businessOnboardingHref } from '#universal/business-onboarding.ts'
import { businessCss } from './business-styles.ts'
import { businessExamples, type BusinessExample } from './business-examples.ts'
import { BusinessHero } from './business-hero.tsx'

export function BusinessRoute(handle: Handle) {
	let current: BusinessExample = 'invoices'
	let mode: 'app' | 'agent' = 'app'
	return () => {
		const example = businessExamples[current]
		return (
			<div mix={css(businessCss)}>
				<div class="wrap">
					<nav class="nav" aria-label="Main navigation">
						<a class="brand" href="/">
							<img src="/logo-64.webp" alt="" width={36} height={36} />
							kody<span>for business</span>
						</a>
						<div class="navlinks">
							<a href="#in-action">See it in action</a>
							<a href="#client-spaces">Client ownership</a>
							<a class="button" href={businessOnboardingHref}>
								Get started{' '}
								<span class="arrow" aria-hidden="true">
									↗
								</span>
							</a>
						</div>
					</nav>
					<div>
						<section class="hero">
							<h1>
								The agent cloud
								<br />
								<span>for your business.</span>
							</h1>
							<BusinessHero />
							<div class="hero-copy">
								<p>
									Give your teams and their AI agents a shared home for tools,
									data, and automations. Run work across departments or client
									organizations, with clear ownership and control over who can
									use or change it.
								</p>
								<a class="button" href={businessOnboardingHref}>
									Get started
									<span class="arrow" aria-hidden="true">
										↗
									</span>
								</a>
								<a href="#in-action" class="text-link">
									Explore a client workflow ↓
								</a>
							</div>
						</section>
						<section
							class="showcase"
							id="in-action"
							aria-label="Interactive client workflow examples"
						>
							<div
								class="example-tabs"
								role="group"
								aria-label="Choose a workflow"
							>
								<button
									data-example="invoices"
									type="button"
									aria-pressed={current === 'invoices'}
									mix={on('click', () => {
										current = 'invoices'
										handle.update()
									})}
								>
									Monthly invoicing
								</button>
								<button
									data-example="audit"
									type="button"
									aria-pressed={current === 'audit'}
									mix={on('click', () => {
										current = 'audit'
										handle.update()
									})}
								>
									Nightly audits
								</button>
								<button
									data-example="onboarding"
									type="button"
									aria-pressed={current === 'onboarding'}
									mix={on('click', () => {
										current = 'onboarding'
										handle.update()
									})}
								>
									Client onboarding
								</button>
							</div>
							<div class="app">
								<aside class="studio">
									<div class="studio-brand">
										<span class="studio-icon" aria-hidden="true">
											N
										</span>
										Northline Studio
									</div>
									<small>Client organizations</small>
									<div class="space active">◈ &nbsp; Acme Construction</div>
									<div class="space">◈ &nbsp; Fieldwork Co.</div>
									<div class="space">◈ &nbsp; Studio operations</div>
									<small>Your library</small>
									<div class="space">▧ &nbsp; Shared packages</div>
									<div class="studio-bottom">
										Maintained by<strong>Northline delivery team</strong>
									</div>
								</aside>
								<div class="workspace">
									<div class="appbar">
										<span>
											Acme Construction &nbsp; / &nbsp;
											<strong>{example.title}</strong>
										</span>
										<span class="live">Active</span>
									</div>
									<div class="workbody">
										<div>
											<p class="request-label">The client’s request</p>
											<p class="request">{example.request}</p>
											<div class="pipeline">
												{example.steps.map((step) => (
													<div key={step}>
														<span class="check" aria-hidden="true">
															✓
														</span>
														{step}
													</div>
												))}
											</div>
											<p class="trigger">{example.trigger}</p>
										</div>
										<div class="output">
											<div class="output-bar">
												<span>Client view</span>
												<div
													class="mode-tabs"
													role="group"
													aria-label="Client interface"
												>
													<button
														data-mode="app"
														type="button"
														aria-pressed={mode === 'app'}
														mix={on('click', () => {
															mode = 'app'
															handle.update()
														})}
													>
														App
													</button>
													<button
														data-mode="agent"
														type="button"
														aria-pressed={mode === 'agent'}
														mix={on('click', () => {
															mode = 'agent'
															handle.update()
														})}
													>
														AI agent
													</button>
												</div>
											</div>
											<div
												class="output-content"
												aria-live="polite"
												aria-atomic="true"
											>
												{mode === 'app' ? (
													<>
														<h2>{example.heading}</h2>
														<p class="output-sub">{example.sub}</p>
														{example.rows.map(([name, status]) => (
															<div class="data-row" key={name}>
																<span>{name}</span>
																<span>{status}</span>
															</div>
														))}
														<p class="output-foot">{example.foot}</p>
													</>
												) : (
													<>
														<p class="agent-prompt">{example.prompt}</p>
														<p class="agent-tool">{example.tool}</p>
														<p class="agent-result">{example.answer}</p>
														<p class="output-foot">
															Using Acme’s shared workflow and permissions
														</p>
													</>
												)}
											</div>
										</div>
									</div>
								</div>
							</div>
							<p class="demo-caption">Illustrative workflow and client data</p>
						</section>
						<div class="capabilities">
							<span>
								<b aria-hidden="true">↗</b>Bring your preferred agent
							</span>
							<span>
								<b aria-hidden="true">◷</b>Run on schedules or webhooks
							</span>
							<span>
								<b aria-hidden="true">▧</b>Keep tools and data between runs
							</span>
							<span>
								<b aria-hidden="true">◈</b>Manage client access
							</span>
						</div>
						<section class="reuse">
							<div class="section-copy">
								<h2>
									Built by your people.
									<br />
									Shared across your business.
								</h2>
								<p>
									Your agent builds the tools. Kody keeps the code, connections,
									and data together, and runs the work on a schedule or when
									something happens, even after the chat closes.
								</p>
								<p>
									Share tools across your teams, or reuse them for the next
									client. Keep each organization’s connections and data separate
									while your people work with their preferred agents.
								</p>
								<a href="#client-spaces" class="text-link">
									Keep each client’s work separate ↓
								</a>
							</div>
							<div
								class="library"
								aria-label="A shared package used in separate client organizations"
							>
								<div class="package">
									<span class="package-icon" aria-hidden="true">
										▧
									</span>
									<div>
										<strong>Invoice reconciliation</strong>
										<small>Northline Studio / shared package</small>
									</div>
								</div>
								<div class="branches">
									<div class="client">
										<strong>Acme Construction</strong>
										<p>Acme accounting connection</p>
										<p>Job codes + progress billing</p>
										<span class="tag">Acme owns the data</span>
									</div>
									<div class="client">
										<strong>Fieldwork Co.</strong>
										<p>Fieldwork accounting connection</p>
										<p>Retainers + monthly billing</p>
										<span class="tag">Fieldwork owns the data</span>
									</div>
								</div>
								<p class="library-note">
									Shared logic. Separate connections and records.
								</p>
							</div>
						</section>
					</div>
				</div>
				<section class="ownership" id="client-spaces">
					<div class="wrap ownership-grid">
						<div class="section-copy">
							<h2>
								Your agency runs it.
								<br />
								Your client owns it.
							</h2>
							<p>
								Give each client an organization for their workflows,
								connections, and data. Keep your team involved for ongoing work,
								or hand it over when the engagement ends.
							</p>
						</div>
						<div>
							<div class="access">
								<div class="access-title">
									Acme Construction <span>People & access</span>
								</div>
								<div class="person">
									<span class="avatar">AL</span>
									<div>
										Alex Lee<small>Acme Construction</small>
									</div>
									<span class="role">Owner</span>
								</div>
								<div class="person">
									<span class="avatar">NS</span>
									<div>
										Northline Studio<small>Agency delivery team</small>
									</div>
									<span class="role">Can maintain</span>
								</div>
								<div class="person">
									<span class="avatar">JT</span>
									<div>
										Jordan Taylor<small>Acme operations</small>
									</div>
									<span class="role">Can run</span>
								</div>
							</div>
							<div class="ownership-notes">
								<div>
									<h3>Share the right access</h3>
									<p>
										Let people run a workflow without giving them its
										credentials or permission to change it.
									</p>
								</div>
								<div>
									<h3>Leave a clear history</h3>
									<p>
										See who ran or changed the work. Remove a teammate without
										removing the client’s tools.
									</p>
								</div>
							</div>
						</div>
					</div>
				</section>
				<div class="wrap">
					<section class="offer">
						<div>
							<h2>
								Put your agents to work
								<br />
								across your business.
							</h2>
							<p>
								Start with one business process. Bring the team that owns it,
								connect the systems it depends on, and decide who can run,
								maintain, and share the work.
							</p>
						</div>
						<div class="offer-card">
							<h3>Start with one workflow.</h3>
							<ul>
								<li>Connect your AI agent</li>
								<li>Connect the tools you use</li>
								<li>Build something useful</li>
							</ul>
							<a class="button" href={businessOnboardingHref}>
								Get started{' '}
								<span class="arrow" aria-hidden="true">
									↗
								</span>
							</a>
						</div>
					</section>
				</div>
			</div>
		)
	}
}
