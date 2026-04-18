<script setup lang="ts">
import { useDarkMode } from '@slidev/client'

const { isDark } = useDarkMode()
</script>

<template>
	<div class="kody-deck-epic-logo" aria-hidden="true">
		<div
			class="kody-deck-epic-logo__mark"
			:class="{ 'kody-deck-epic-logo__mark--theme-dark': isDark }"
		/>
	</div>
</template>

<style scoped>
.kody-deck-epic-logo {
	position: fixed;
	right: clamp(0.75rem, 2.2vmin, 1.25rem);
	bottom: clamp(0.75rem, 2.2vmin, 1.25rem);
	width: 42px;
	height: 42px;
	z-index: 25;
	pointer-events: none;
}

/*
  Shape from SVG. Force alpha masking so the asset’s orange / partial opacity
  is not interpreted as luminance (which was washing the mark down to mud on
  dark slides).
*/
.kody-deck-epic-logo__mark {
	width: 100%;
	height: 100%;
	background: linear-gradient(135deg, #0d0d0d 0%, #4a4a4a 100%);
	mask-image: url('/epicproductengineer-fav.svg');
	mask-size: contain;
	mask-repeat: no-repeat;
	mask-position: center;
	mask-mode: alpha;
	-webkit-mask-image: url('/epicproductengineer-fav.svg');
	-webkit-mask-size: contain;
	-webkit-mask-repeat: no-repeat;
	-webkit-mask-position: center;
	-webkit-mask-source-type: alpha;
}

.kody-deck-epic-logo__mark--theme-dark {
	background: linear-gradient(135deg, #ffffff 0%, #f4f4f4 45%, #ebebeb 100%);
}
</style>
