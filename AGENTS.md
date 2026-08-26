# pi-extension-mgr

A [pi package](https://pi.dev) that enables/disables pi extensions at runtime
(`/ext-mgr`) and via the `--ignore-extension` CLI option. It does **not**
install or remove extensions — that's `pi install` / `pi remove` (`npm run
prepublishOnly` runs the check gate).

## Commands

- `npm run typecheck` — `tsc --noEmit` on `index.ts` + `test/`
- `npm test` — node test runner (`test/package.test.ts`)
- `npm run check` — typecheck + test (wired to `prepublishOnly`)
- `npm run prepublishOnly` — the gate run before `npm publish`

## Notes

- `index.ts` uses TypeScript **parameter properties**, which Node's strip-only
  transform rejects. Tests therefore load the extension through **jiti**
  (`test/package.test.ts`), the same transform pi uses to run extensions — do
  not switch `test` to plain `node --test` on the extension.
- The published package ships only `index.ts`, `README.md`, `LICENSE`,
  `package.json` (via `files`); `tsconfig.json`, `test/`, and workflows are dev
  only.
- Core pi packages (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`)
  are bundled by pi, so they are `peerDependencies` (optional), never bundled.
- Publish: GitHub Actions `release.yml` uses npm OIDC trusted publishing
  (`npm publish --provenance`) on `workflow_dispatch`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
