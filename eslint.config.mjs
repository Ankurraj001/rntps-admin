import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', '**/.vite/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // Mongoose and Express types produce plenty of legitimate `any` boundaries.
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
  {
    // Netlify's modern function format hands the handler web platform globals, which are
    // real at runtime but invisible to the default ES environment.
    files: ['netlify/functions/**/*.mjs'],
    languageOptions: { globals: { Request: 'readonly', Response: 'readonly' } },
  },
);
