module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint'],
  env: { es2022: true },
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  rules: {
    'no-eval': 'error',
    'no-new-func': 'error',
    'no-restricted-imports': ['error', { patterns: ['footprintjs', 'footprintjs/*', 'node:*', 'fs', 'path', 'process'] }],
  },
};
