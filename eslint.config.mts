import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';
import { globalIgnores, defineConfig } from 'eslint/config';

export default defineConfig(
	globalIgnores([
		'node_modules',
		'dist',
		'esbuild.config.mjs',
		'version-bump.mjs',
		'versions.json',
		'main.js',
		'package.json',
		'package-lock.json',
		'tsconfig.json',
		'test/**',
	]),
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: ['eslint.config.mts', 'manifest.json'],
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json'],
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		// ponytail: declarative getSettingDefinitions() bypasses display() on Obsidian 1.13+ runtime,
		// breaking imperative settings controls. Suppress until declarative API supports custom controls.
		rules: {
			'obsidianmd/settings-tab/prefer-setting-definitions': 'off',
			'obsidianmd/ui/sentence-case': ['warn', {
				enforceCamelCaseLower: true,
				ignoreRegex: ['AnkiConnect', '^https?://', '^⚠️ AnkiConnect error$', '^↗️ Open Anki$'],
			}],
		},
	},
);
