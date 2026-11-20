// @ts-check
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'coverage/', 'node_modules/'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Never build shell strings or evaluate code. Process creation goes through the
      // execution manager with argument arrays (see docs/architecture.md §7).
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'node:child_process',
              importNames: ['exec', 'execSync'],
              message:
                'exec/execSync run through a shell. Use the execution manager (spawn, shell: false).',
            },
            {
              name: 'child_process',
              message: "Import from 'node:child_process' and do not use exec/execSync.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // Test fixtures run as plain Node scripts; TypeScript does not check them.
    files: ['tests/fixtures/**/*.mjs'],
    rules: { 'no-undef': 'off' },
  },
  prettier,
);
