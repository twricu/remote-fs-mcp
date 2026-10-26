import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: globals.node },
    rules: {
      'no-console': 'error',
      'no-restricted-properties': ['error', { object: 'process', property: 'stdout', message: 'Only the MCP SDK may write protocol stdout.' }],
      'no-restricted-syntax': ['error', { selector: 'CallExpression[callee.property.name=/^(exec|shell|forwardOut|forwardIn|subsys)$/]', message: 'Remote commands and forwarding are outside the server policy.' }],
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      'no-restricted-imports': ['error', { paths: ['node:child_process', 'child_process'] }]
    }
  },
  { files: ['test/**/*.js', 'scripts/**/*.js'], rules: { 'no-restricted-imports': 'off' } }
];
