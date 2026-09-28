import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores([
    'dist',
    '.vercel',
    'coverage',
    'playwright-report',
    'test-results',
    'apps-script/build',
    'apps-script/.client-build',
  ]),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['web/**/*.{ts,tsx}', 'apps-script/client/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat['recommended-latest'], reactRefresh.configs.vite],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['web/public/**/*.js'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: [
      'server/**/*.{ts,mjs}',
      'e2e/**/*.{ts,mjs}',
      '*.config.{ts,js}',
      'apps-script/*.{ts,mjs}',
      'apps-script/{test,e2e}/**/*.ts',
    ],
    languageOptions: { globals: globals.node },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
    },
  },
);
