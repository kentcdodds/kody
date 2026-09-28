import { Composition } from 'remotion'
import { loadBrandFonts } from './fonts.ts'
import { PersonalSoftwareConnected } from './personal-software-connected.tsx'
import { durationInFrames, fps, height, width } from './timing.ts'

void loadBrandFonts()

export function Root() {
	return (
		<Composition
			id="PersonalSoftwareConnected"
			component={PersonalSoftwareConnected}
			durationInFrames={durationInFrames}
			fps={fps}
			width={width}
			height={height}
		/>
	)
}
