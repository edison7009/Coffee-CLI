import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
  },
  {
    // These modules intentionally co-locate components with shared hooks,
    // context, and terminal configuration. Vite safely falls back to a full
    // reload for them; splitting the exports would create circular module
    // boundaries without improving runtime correctness.
    files: [
      'src/store/app-state.tsx',
      'src/lib/git-status.tsx',
      'src/components/center/TierTerminal.tsx',
      'src/components/center/CenterPanel.tsx',
    ],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
])
