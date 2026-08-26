import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createJiti } from "jiti";
import test from "node:test";
import assert from "node:assert/strict";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  name?: string;
  keywords?: string[];
  pi?: { extensions?: string[] };
  type?: string;
  peerDependencies?: Record<string, string>;
};

test("manifest declares a publishable pi package", () => {
  assert.equal(manifest.name, "pi-extension-mgr");
  assert.equal(manifest.type, "module");
  assert.ok(
    Array.isArray(manifest.keywords) && manifest.keywords.includes("pi-package"),
    "package.json must include the `pi-package` keyword for discoverability",
  );
  assert.deepEqual(manifest.pi?.extensions, ["./index.ts"]);
  // Bundled core packages must be declared as peer dependencies, not bundled.
  assert.ok(manifest.peerDependencies?.["@earendil-works/pi-coding-agent"]);
  assert.ok(manifest.peerDependencies?.["@earendil-works/pi-tui"]);
});

test("index.ts exports a default extension factory function", async () => {
  // The extension uses TS parameter properties, which Node's strip-only
  // transform does not support. Load it through jiti (the same transform pi
  // uses to run extensions) so parameter properties are compiled.
  const jiti = createJiti(import.meta.url, {
    interopDefault: false,
    moduleCache: false,
  });
  const mod = (await jiti.import(join(root, "index.ts"))) as {
    default?: unknown;
  };
  assert.equal(typeof mod.default, "function", "index.ts must default-export a factory function");
});
