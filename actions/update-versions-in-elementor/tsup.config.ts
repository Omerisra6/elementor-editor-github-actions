import { defineConfig } from 'tsup';

export default defineConfig({
	entry: ['./index.ts'],
	format: ['cjs'],
	clean: true,
	noExternal: [
		// Include all dependencies in the bundle
		'.*',
	],
}); 