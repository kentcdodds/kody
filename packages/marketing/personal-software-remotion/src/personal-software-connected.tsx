import { Audio } from '@remotion/media'
import { type ReactNode } from 'react'
import { AbsoluteFill, Sequence, staticFile } from 'remotion'
import { Backdrop } from './components/backdrop.tsx'
import { Lantern } from './components/lantern.tsx'
import { PersonalApp } from './components/personal-app.tsx'
import { ArrivalsOverlay, ConnectOnce } from './scenes/connect-once.tsx'
import { AppBeams, GenerateApp, PromptBar } from './scenes/generate-app.tsx'
import { IntegrationTax } from './scenes/integration-tax.tsx'
import { StaysLit } from './scenes/stays-lit.tsx'
import { Tagline, TaglineRing } from './scenes/tagline.tsx'
import { musicVolume, scenes } from './timing.ts'

type SceneId = keyof typeof scenes

function Scene({
	id,
	name,
	until,
	children,
}: {
	id: SceneId
	name: string
	until?: number
	children: ReactNode
}) {
	const scene = scenes[id]
	return (
		<Sequence
			from={scene.from}
			durationInFrames={(until ?? scene.until) - scene.from}
			name={name}
		>
			{children}
		</Sequence>
	)
}

/**
 * Layer order matters: beams and panels sit under the lantern so they rise
 * out of the glass; flying marks and the front of the closing ring sit over
 * it. Scene components add their `from` back to read global cue frames.
 */
export function PersonalSoftwareConnected() {
	return (
		<AbsoluteFill style={{ backgroundColor: 'black' }}>
			<Backdrop />
			<Scene id="integrationTax" name="Beat 1 · integration tax">
				<IntegrationTax />
			</Scene>
			<Scene id="connectOnce" name="Beat 2 · connect once">
				<ConnectOnce />
			</Scene>
			<Scene id="generateApp" name="Beat 3 · headline">
				<GenerateApp />
			</Scene>
			<Scene
				id="generateApp"
				name="Beats 3–4 · app beams"
				until={scenes.staysLit.until}
			>
				<AppBeams />
			</Scene>
			<Scene id="staysLit" name="Beat 4 · stays lit">
				<StaysLit />
			</Scene>
			<Scene
				id="generateApp"
				name="Beats 3–4 · personal app"
				until={scenes.staysLit.until}
			>
				<PersonalApp />
			</Scene>
			<Scene id="generateApp" name="Beat 3 · prompt">
				<PromptBar />
			</Scene>
			<Scene id="tagline" name="Close · ring (back)">
				<TaglineRing layer="back" />
			</Scene>
			<Lantern />
			<Scene id="connectOnce" name="Beat 2 · arrivals">
				<ArrivalsOverlay />
			</Scene>
			<Scene id="tagline" name="Close · ring (front)">
				<TaglineRing layer="front" />
			</Scene>
			<Scene id="tagline" name="Close · tagline">
				<Tagline />
			</Scene>
			<Audio
				src={staticFile('music/kody-warm-drive.wav')}
				volume={musicVolume}
			/>
		</AbsoluteFill>
	)
}
