type RuntimeEnv = Env & {
	AI?: unknown
}

type ChatMessage = {
	role: 'user' | 'assistant'
	content: string
}

type ChatRequestBody = {
	message?: unknown
	messages?: unknown
}

const systemPrompt = [
	'You are Kody Voice, a concise spoken assistant running inside a Kody package app.',
	'Keep answers short enough to be spoken aloud.',
	'Use available tools when the user asks about Kody capabilities or current time.',
	'Never claim the Cloudflare Voice transport is connected until the runtime reports it.',
].join(' ')

function json(data: unknown, init?: ResponseInit) {
	const headers = new Headers(init?.headers)
	headers.set('Content-Type', 'application/json')
	headers.set('Cache-Control', 'no-store')
	return new Response(JSON.stringify(data), { ...init, headers })
}

function html(body: string, init?: ResponseInit) {
	const headers = new Headers(init?.headers)
	headers.set('Content-Type', 'text/html; charset=utf-8')
	headers.set('Cache-Control', 'no-store')
	return new Response(body, { ...init, headers })
}

function normalizeMessages(value: unknown): Array<ChatMessage> {
	if (!Array.isArray(value)) return []
	return value.flatMap((item): Array<ChatMessage> => {
		if (!item || typeof item !== 'object') return []
		const record = item as Record<string, unknown>
		const role = record.role === 'assistant' ? 'assistant' : 'user'
		const content =
			typeof record.content === 'string' ? record.content.trim() : ''
		return content ? [{ role, content }] : []
	})
}

async function readChatRequest(request: Request) {
	let body: ChatRequestBody
	try {
		body = (await request.json()) as ChatRequestBody
	} catch {
		return {
			ok: false as const,
			response: json({ error: 'Invalid JSON.' }, { status: 400 }),
		}
	}
	const message = typeof body.message === 'string' ? body.message.trim() : ''
	if (!message) {
		return {
			ok: false as const,
			response: json(
				{ error: 'Enter something for Kody to answer.' },
				{ status: 400 },
			),
		}
	}
	return {
		ok: true as const,
		message,
		messages: normalizeMessages(body.messages),
	}
}

async function handleChat(request: Request, env: RuntimeEnv) {
	const parsed = await readChatRequest(request)
	if (!parsed.ok) return parsed.response

	if (!env.AI) {
		return json(
			{
				error:
					'Workers AI is not exposed to package apps yet. The UI is ready; connect env.AI to enable live model responses.',
			},
			{ status: 503 },
		)
	}

	const [
		{ streamText, tool, stepCountIs },
		{ createWorkersAI },
		{ z },
		runtime,
	] = await Promise.all([
		import('ai'),
		import('workers-ai-provider'),
		import('zod'),
		import('kody:runtime'),
	])
	const { codemode } = runtime
	const workersAi = createWorkersAI({ binding: env.AI })
	const result = streamText({
		model: workersAi('@cf/moonshotai/kimi-k2.6'),
		system: systemPrompt,
		messages: [
			...parsed.messages.map((message) => ({
				role: message.role,
				content: message.content,
			})),
			{ role: 'user' as const, content: parsed.message },
		],
		tools: {
			get_current_time: tool({
				description: 'Get the current date and time for the user.',
				inputSchema: z.object({}),
				execute: async () => ({ iso: new Date().toISOString() }),
			}),
			list_kody_capabilities: tool({
				description:
					'List a small sample of Kody capabilities available to this package app.',
				inputSchema: z.object({}),
				execute: async () => {
					const capabilities = await codemode.meta_list_capabilities({})
					const list = Array.isArray(capabilities) ? capabilities : []
					return {
						count: list.length,
						sample: list.slice(0, 8).map((capability) => {
							const record = capability as Record<string, unknown>
							return {
								name: record.name,
								domain: record.domain,
							}
						}),
					}
				},
			}),
		},
		stopWhen: stepCountIs(4),
	})

	const encoder = new TextEncoder()
	const stream = new ReadableStream({
		async start(controller) {
			try {
				for await (const chunk of result.textStream) {
					controller.enqueue(encoder.encode(chunk))
				}
				controller.close()
			} catch (error) {
				controller.error(error)
			}
		},
	})
	return new Response(stream, {
		headers: {
			'Cache-Control': 'no-store',
			'Content-Type': 'text/plain; charset=utf-8',
		},
	})
}

function renderPage(aiReady: boolean) {
	const statusText = aiReady
		? 'AI model route ready. Voice transport waits for the package AI binding work.'
		: 'UI ready. Workers AI is not exposed to package apps yet.'

	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<title>Kody Voice</title>
	<style>
		:root {
			color-scheme: light dark;
			--bg: #f7f4ee;
			--panel: rgba(255, 255, 255, 0.82);
			--panel-strong: #ffffff;
			--text: #171412;
			--muted: #625b52;
			--border: rgba(40, 31, 24, 0.14);
			--accent: #7c3aed;
			--accent-strong: #5b21b6;
			--accent-soft: rgba(124, 58, 237, 0.14);
			--danger: #b42318;
			--shadow: 0 24px 80px rgba(44, 31, 16, 0.16);
		}

		[data-theme="dark"] {
			color-scheme: dark;
			--bg: #111017;
			--panel: rgba(30, 28, 38, 0.86);
			--panel-strong: #24212e;
			--text: #f8f5ff;
			--muted: #c8c0d8;
			--border: rgba(255, 255, 255, 0.14);
			--accent: #a78bfa;
			--accent-strong: #c4b5fd;
			--accent-soft: rgba(167, 139, 250, 0.18);
			--danger: #fda29b;
			--shadow: 0 24px 80px rgba(0, 0, 0, 0.34);
		}

		@media (prefers-color-scheme: dark) {
			:root:not([data-theme="light"]) {
				color-scheme: dark;
				--bg: #111017;
				--panel: rgba(30, 28, 38, 0.86);
				--panel-strong: #24212e;
				--text: #f8f5ff;
				--muted: #c8c0d8;
				--border: rgba(255, 255, 255, 0.14);
				--accent: #a78bfa;
				--accent-strong: #c4b5fd;
				--accent-soft: rgba(167, 139, 250, 0.18);
				--danger: #fda29b;
				--shadow: 0 24px 80px rgba(0, 0, 0, 0.34);
			}
		}

		* {
			box-sizing: border-box;
		}

		body {
			min-height: 100dvh;
			margin: 0;
			background:
				radial-gradient(circle at top left, var(--accent-soft), transparent 34rem),
				linear-gradient(135deg, var(--bg), color-mix(in srgb, var(--bg), var(--accent) 8%));
			color: var(--text);
			font-family:
				Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI",
				sans-serif;
			line-height: 1.5;
		}

		button,
		textarea {
			font: inherit;
		}

		button:focus-visible,
		textarea:focus-visible {
			outline: 3px solid color-mix(in srgb, var(--accent), white 22%);
			outline-offset: 3px;
		}

		.shell {
			width: min(1120px, calc(100% - 32px));
			margin: 0 auto;
			padding: 32px 0;
		}

		.hero {
			display: grid;
			grid-template-columns: minmax(0, 1.08fr) minmax(280px, 0.92fr);
			gap: 24px;
			align-items: stretch;
		}

		.card {
			border: 1px solid var(--border);
			border-radius: 28px;
			background: var(--panel);
			box-shadow: var(--shadow);
			backdrop-filter: blur(18px);
		}

		.intro {
			padding: clamp(24px, 5vw, 56px);
		}

		.eyebrow {
			display: inline-flex;
			gap: 8px;
			align-items: center;
			margin: 0 0 18px;
			padding: 8px 12px;
			border: 1px solid var(--border);
			border-radius: 999px;
			background: var(--accent-soft);
			color: var(--accent-strong);
			font-weight: 700;
			font-size: 0.88rem;
		}

		h1 {
			max-width: 12ch;
			margin: 0;
			font-size: clamp(2.8rem, 8vw, 6.8rem);
			line-height: 0.9;
			letter-spacing: -0.07em;
		}

		.lede {
			max-width: 62ch;
			margin: 24px 0 0;
			color: var(--muted);
			font-size: clamp(1rem, 2vw, 1.18rem);
		}

		.controls {
			display: flex;
			flex-wrap: wrap;
			gap: 12px;
			margin-top: 28px;
		}

		.button {
			display: inline-flex;
			min-height: 44px;
			align-items: center;
			justify-content: center;
			gap: 10px;
			border: 1px solid transparent;
			border-radius: 999px;
			padding: 12px 18px;
			cursor: pointer;
			font-weight: 800;
		}

		.button-primary {
			background: var(--accent);
			color: #fff;
		}

		.button-secondary {
			border-color: var(--border);
			background: var(--panel-strong);
			color: var(--text);
		}

		.button[disabled] {
			cursor: not-allowed;
			opacity: 0.6;
		}

		.console {
			display: grid;
			gap: 16px;
			padding: 18px;
		}

		.status-card {
			display: grid;
			gap: 16px;
			padding: 22px;
			border-radius: 22px;
			background: var(--panel-strong);
		}

		.orb {
			position: relative;
			display: grid;
			width: min(100%, 260px);
			aspect-ratio: 1;
			place-items: center;
			margin: 8px auto 4px;
			border-radius: 50%;
			background:
				radial-gradient(circle at 38% 30%, #fff, transparent 16%),
				radial-gradient(circle, var(--accent), var(--accent-strong));
			color: #fff;
			font-weight: 900;
			letter-spacing: 0.08em;
			text-transform: uppercase;
		}

		.orb::after {
			position: absolute;
			inset: -10px;
			border: 2px solid color-mix(in srgb, var(--accent), transparent 60%);
			border-radius: inherit;
			content: "";
		}

		[data-state="thinking"] .orb::after {
			animation: pulse 1s ease-in-out infinite;
		}

		@keyframes pulse {
			50% {
				transform: scale(1.08);
				opacity: 0.35;
			}
		}

		.status-line {
			margin: 0;
			color: var(--muted);
			text-align: center;
		}

		.status-pill {
			justify-self: center;
			padding: 6px 10px;
			border-radius: 999px;
			background: var(--accent-soft);
			color: var(--accent-strong);
			font-size: 0.82rem;
			font-weight: 800;
			text-transform: uppercase;
		}

		.transcript {
			display: grid;
			gap: 12px;
			max-height: 360px;
			overflow: auto;
			padding: 4px;
		}

		.message {
			max-width: 88%;
			border: 1px solid var(--border);
			border-radius: 18px;
			padding: 12px 14px;
			background: var(--panel-strong);
		}

		.message-user {
			justify-self: end;
			background: var(--accent);
			color: #fff;
		}

		.message strong {
			display: block;
			margin-bottom: 4px;
			font-size: 0.78rem;
			text-transform: uppercase;
		}

		.composer {
			display: grid;
			gap: 10px;
		}

		label {
			font-weight: 800;
		}

		textarea {
			width: 100%;
			min-height: 112px;
			resize: vertical;
			border: 1px solid var(--border);
			border-radius: 18px;
			padding: 14px;
			background: var(--panel-strong);
			color: var(--text);
		}

		.hint,
		.error {
			margin: 0;
			font-size: 0.92rem;
		}

		.hint {
			color: var(--muted);
		}

		.error {
			color: var(--danger);
			font-weight: 700;
		}

		.features {
			display: grid;
			grid-template-columns: repeat(3, minmax(0, 1fr));
			gap: 14px;
			margin-top: 24px;
		}

		.feature {
			padding: 18px;
			border: 1px solid var(--border);
			border-radius: 20px;
			background: color-mix(in srgb, var(--panel-strong), transparent 14%);
		}

		.feature h2 {
			margin: 0 0 6px;
			font-size: 1rem;
		}

		.feature p {
			margin: 0;
			color: var(--muted);
		}

		.visually-hidden {
			position: absolute;
			width: 1px;
			height: 1px;
			overflow: hidden;
			clip: rect(0, 0, 0, 0);
			white-space: nowrap;
		}

		@media (max-width: 820px) {
			.shell {
				width: min(100% - 20px, 680px);
				padding: 10px 0;
			}

			.hero,
			.features {
				grid-template-columns: 1fr;
			}

			.intro,
			.console {
				padding: 18px;
			}

			.card {
				border-radius: 22px;
			}
		}

		@media (prefers-reduced-motion: reduce) {
			* {
				scroll-behavior: auto !important;
				animation-duration: 0.001ms !important;
				animation-iteration-count: 1 !important;
				transition-duration: 0.001ms !important;
			}
		}
	</style>
</head>
<body>
	<main class="shell">
		<section class="hero" aria-labelledby="page-title">
			<div class="card intro">
				<p class="eyebrow">Authenticated Kody package app</p>
				<h1 id="page-title">Kody Voice</h1>
				<p class="lede">
					A voice-console starter for Cloudflare Voice. The UI, accessible states,
					tool-call loop, and thinking sound are in place; the live Workers AI voice
					transport can connect when Kody exposes package app AI bindings.
				</p>
				<div class="controls">
					<button class="button button-primary" id="call-button" type="button" aria-pressed="false">
						Start call
					</button>
					<button class="button button-secondary" id="sound-button" type="button" aria-pressed="true">
						Thinking sound on
					</button>
					<button class="button button-secondary" id="theme-button" type="button">
						Toggle theme
					</button>
				</div>
				<p class="hint" id="runtime-note">${statusText}</p>
			</div>
			<div class="card console" data-state="idle" id="console">
				<section class="status-card" aria-labelledby="status-heading">
					<h2 class="visually-hidden" id="status-heading">Call status</h2>
					<div class="status-pill" id="status-pill">Idle</div>
					<div class="orb" aria-hidden="true">Kody</div>
					<p class="status-line" id="status-line" aria-live="polite">
						Start a call, then send a typed utterance while voice transport is pending.
					</p>
				</section>
				<section aria-labelledby="transcript-heading">
					<h2 class="visually-hidden" id="transcript-heading">Transcript</h2>
					<div class="transcript" id="transcript" role="log" aria-live="polite" aria-relevant="additions text"></div>
				</section>
				<form class="composer" id="composer">
					<label for="utterance">Utterance</label>
					<textarea id="utterance" name="utterance" placeholder="Ask Kody what tools it can use..." disabled></textarea>
					<p class="hint">
						The send path uses an AI SDK tool loop, not Kody agent turns.
					</p>
					<p class="error" id="error" role="alert"></p>
					<button class="button button-primary" id="send-button" type="submit" disabled>
						Send utterance
					</button>
				</form>
			</div>
		</section>
		<section class="features" aria-label="Implementation notes">
			<article class="feature">
				<h2>Responsive</h2>
				<p>Single-column mobile layout, large touch targets, and reduced-motion support.</p>
			</article>
			<article class="feature">
				<h2>Accessible</h2>
				<p>Semantic controls, visible focus, live transcript updates, and status announcements.</p>
			</article>
			<article class="feature">
				<h2>Tool-ready</h2>
				<p>Model tools call Kody capabilities through <code>codemode</code>, without agent turns.</p>
			</article>
		</section>
	</main>
	<script type="module">
		const root = document.documentElement;
		const consoleEl = document.getElementById('console');
		const callButton = document.getElementById('call-button');
		const soundButton = document.getElementById('sound-button');
		const themeButton = document.getElementById('theme-button');
		const statusPill = document.getElementById('status-pill');
		const statusLine = document.getElementById('status-line');
		const transcript = document.getElementById('transcript');
		const composer = document.getElementById('composer');
		const utterance = document.getElementById('utterance');
		const sendButton = document.getElementById('send-button');
		const errorEl = document.getElementById('error');
		let callActive = false;
		let soundEnabled = true;
		let audioContext;
		let thinkingTimer;
		const messages = [];

		const savedTheme = localStorage.getItem('kody-voice-theme');
		if (savedTheme === 'light' || savedTheme === 'dark') {
			root.dataset.theme = savedTheme;
		}

		function setStatus(state, message) {
			consoleEl.dataset.state = state;
			statusPill.textContent = state;
			statusLine.textContent = message;
		}

		function appendMessage(role, content) {
			const message = document.createElement('article');
			message.className = 'message ' + (role === 'user' ? 'message-user' : 'message-assistant');
			const label = document.createElement('strong');
			label.textContent = role === 'user' ? 'You' : 'Kody';
			const text = document.createElement('span');
			text.textContent = content;
			message.append(label, text);
			transcript.append(message);
			transcript.scrollTop = transcript.scrollHeight;
			return text;
		}

		function playTick() {
			if (!soundEnabled) return;
			audioContext ??= new AudioContext();
			const oscillator = audioContext.createOscillator();
			const gain = audioContext.createGain();
			oscillator.frequency.value = 440;
			gain.gain.setValueAtTime(0.0001, audioContext.currentTime);
			gain.gain.exponentialRampToValueAtTime(0.045, audioContext.currentTime + 0.015);
			gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 0.12);
			oscillator.connect(gain).connect(audioContext.destination);
			oscillator.start();
			oscillator.stop(audioContext.currentTime + 0.14);
		}

		function startThinkingSound() {
			stopThinkingSound();
			playTick();
			thinkingTimer = window.setInterval(playTick, 620);
		}

		function stopThinkingSound() {
			if (thinkingTimer) {
				window.clearInterval(thinkingTimer);
				thinkingTimer = undefined;
			}
		}

		callButton.addEventListener('click', () => {
			callActive = !callActive;
			callButton.setAttribute('aria-pressed', String(callActive));
			callButton.textContent = callActive ? 'End call' : 'Start call';
			utterance.disabled = !callActive;
			sendButton.disabled = !callActive;
			errorEl.textContent = '';
			setStatus(
				callActive ? 'listening' : 'idle',
				callActive
					? 'Listening mode ready. Type an utterance until Cloudflare Voice transport is connected.'
					: 'Call ended.',
			);
			if (callActive) utterance.focus();
		});

		soundButton.addEventListener('click', () => {
			soundEnabled = !soundEnabled;
			soundButton.setAttribute('aria-pressed', String(soundEnabled));
			soundButton.textContent = soundEnabled ? 'Thinking sound on' : 'Thinking sound off';
			if (!soundEnabled) stopThinkingSound();
		});

		themeButton.addEventListener('click', () => {
			const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
			root.dataset.theme = next;
			localStorage.setItem('kody-voice-theme', next);
		});

		composer.addEventListener('submit', async (event) => {
			event.preventDefault();
			const text = utterance.value.trim();
			if (!text) {
				errorEl.textContent = 'Enter an utterance first.';
				utterance.focus();
				return;
			}
			errorEl.textContent = '';
			utterance.value = '';
			appendMessage('user', text);
			messages.push({ role: 'user', content: text });
			const assistantText = appendMessage('assistant', '');
			setStatus('thinking', 'Kody is thinking. Pending sound is playing.');
			startThinkingSound();
			sendButton.disabled = true;
			try {
				const response = await fetch(new URL('api/chat', window.location.href), {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ message: text, messages: messages.slice(-8) }),
				});
				if (!response.ok) {
					const payload = await response.json().catch(() => ({}));
					throw new Error(payload.error || 'Kody could not answer yet.');
				}
				const reader = response.body.getReader();
				const decoder = new TextDecoder();
				let answer = '';
				while (true) {
					const { value, done } = await reader.read();
					if (done) break;
					answer += decoder.decode(value, { stream: true });
					assistantText.textContent = answer;
				}
				messages.push({ role: 'assistant', content: answer || 'Done.' });
				setStatus('speaking', 'Response ready. Voice playback can replace text once transport is wired.');
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				assistantText.textContent = message;
				errorEl.textContent = message;
				setStatus('listening', 'Still listening. Fix setup or try another utterance.');
			} finally {
				stopThinkingSound();
				sendButton.disabled = !callActive;
			}
		});
	</script>
</body>
</html>`
}

export default {
	async fetch(request: Request, env: RuntimeEnv) {
		const url = new URL(request.url)
		if (url.pathname === '/api/status') {
			return json({
				aiReady: Boolean(env.AI),
				voiceTransportReady: false,
				toolLoopReady: true,
			})
		}
		if (url.pathname === '/api/chat') {
			if (request.method !== 'POST') {
				return json({ error: 'Method not allowed.' }, { status: 405 })
			}
			return await handleChat(request, env)
		}
		return html(renderPage(Boolean(env.AI)))
	},
}
