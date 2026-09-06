/**
 * The classroom personas (`featrues/13-classroom/spec.md` §7.1) are markdown
 * files imported as text: `build.js` gives both esbuild bundles
 * `loader: { '.md': 'text' }`, and the test files' on-the-fly compiles do
 * the same. TypeScript has no loader, so the module shape is declared here.
 * Precedent: `src/types/pi-ai.d.ts`.
 */
declare module '*.md' {
  const text: string;
  export default text;
}
