// The vitest suites from before the onion layers; the node:test suites in tests/<layer>/ run with node --test.
export default { test: { include: ['tests/legacy/**/*.test.ts'], environment: 'node' } };
