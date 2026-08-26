/**
 * Ext Manager (ext-mgr)
 *
 * Selectively disable extensions (their tools, skills, prompt templates, and
 * slash commands) via a CLI flag or a runtime command. A disabled extension
 * acts as if it were not installed (to the extent possible at runtime:
 * event-only hooks cannot be removed).
 *
 * CLI:
 *   pi --ignore-extension "subagents,web-access"
 *   pi --ignore-extension subagents --ignore-extension web-access
 *
 * Slash command:
 *   /ext-mgr                     - interactive enable/disable menu (TUI)
 *   /ext-mgr <pat>               - ignore extensions matching <pat>
 *   /ext-mgr reset               - restore everything
 *
 * State: runtime disables are persisted as a session entry and restored on
 * every session start, so they survive /reload, /resume, and /fork just like
 * the CLI flag does (the flag is re-applied at startup because flags are
 * process-global). The /ext-mgr menu and pattern command share the same
 * persistence path.
 *
 * Patterns are comma-separated substrings, matched (case-insensitive) against
 * the extension label, package name, source, file path, tool names, skill
 * names, and prompt-template names.
 *
 * Mechanism:
 *   tools        -> setActiveTools()
 *   skills       -> before_agent_start rebuilds the <available_skills> block
 *   prompts/skills/extension commands whose owning extension is ignored
 *                -> input event intercepts and returns "handled"
 *   event hooks  -> not removable at runtime (limitation)
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import { Text, truncateToWidth, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
import {
  CONFIG_DIR_NAME,
  formatSkillsForPrompt,
  getAgentDir,
  keyHint,
  rawKeyHint,
  type ExtensionAPI,
  type ExtensionContext,
  type Skill,
  type SlashCommandInfo,
  type Theme,
} from "@earendil-works/pi-coding-agent";

// ───────────────────────────────────────────────────────────────────────────
// Types & small helpers
// ───────────────────────────────────────────────────────────────────────────

interface ExtEntry {
  /** Unique table identity: the extension file's absolute path. */
  key: string;
  /** Clean display label. */
  label: string;
  path: string;
  /** sourceInfo.source. */
  source: string;
  /** Package source for package entries (e.g. "npm:pi-subagents"). */
  packageKey?: string;
  packageName?: string;
  scope: "user" | "project" | "temporary";
}

interface ExtRow extends ExtEntry {
  _tools: string[];
  _skills: string[];
  _prompts: string[];
  _commands: string[];
}

type PackageManifest = { pi?: { extensions?: string[] } };
type Settings = { packages?: string[]; extensions?: string[] };

function plural(n: number, word: string): string {
  return `${n} ${word}${n > 1 ? "s" : ""}`;
}

function isPackageSource(source: string): boolean {
  return source.startsWith("npm:") || source.startsWith("git:");
}

// ───────────────────────────────────────────────────────────────────────────
// SourceInfo → keys
//   keyByPath:   attachment key for tools and extension commands (file path).
//   keyForIgnore: grouping key for skills, prompts, and the ignore set
//                 (package source, or file path for local).
//   Both return null for synthetic sourceInfo (path starts with "<").
// ───────────────────────────────────────────────────────────────────────────

function keyByPath(info: { path?: string } | undefined): string | null {
  const p = info?.path ?? "";
  return p.startsWith("<") ? null : p || null;
}

function keyForIgnore(
  info: { path?: string; source?: string } | undefined,
): string | null {
  const p = info?.path ?? "";
  if (p.startsWith("<")) return null;
  const s = info?.source ?? "";
  return isPackageSource(s) ? s : p || null;
}

function ignoreKeyForEntry(entry: ExtEntry): string {
  return entry.packageKey ?? entry.key;
}

// ───────────────────────────────────────────────────────────────────────────
// Discovery
// ───────────────────────────────────────────────────────────────────────────

function readJsonSafe<T>(path: string): T | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function isLocalExtFile(name: string): boolean {
  return name.endsWith(".ts") || name.endsWith(".js");
}

function makeLocalEntry(path: string, scope: ExtEntry["scope"]): ExtEntry {
  return { key: path, label: "", path, source: "local", scope };
}

/** Resolve a directory to its extension entry file paths.  Honours
 *  `package.json` `pi.extensions` if present, otherwise a single
 *  `index.ts` / `index.js`. */
function resolveEntriesInDir(dir: string): string[] {
  const pkg = readJsonSafe<PackageManifest>(join(dir, "package.json"));
  if (pkg?.pi?.extensions?.length) {
    return pkg.pi.extensions
      .map((rel) => resolve(dir, rel))
      .filter(existsSync);
  }
  const ts = join(dir, "index.ts");
  const js = join(dir, "index.js");
  if (existsSync(ts)) return [ts];
  if (existsSync(js)) return [js];
  return [];
}

function discoverLocalDir(dir: string, scope: ExtEntry["scope"]): ExtEntry[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  try {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, item.name);
      if ((item.isFile() || item.isSymbolicLink()) && isLocalExtFile(item.name)) {
        found.push(p);
      } else if (item.isDirectory() || item.isSymbolicLink()) {
        found.push(...resolveEntriesInDir(p));
      }
    }
  } catch {
    return [];
  }
  return found.map((p) => makeLocalEntry(p, scope));
}

function resolveNpmInstallPath(
  pkgName: string,
  agentNpmDir: string,
  projectNpmDir: string,
): string | null {
  const proj = join(projectNpmDir, "node_modules", pkgName);
  if (existsSync(join(proj, "package.json"))) return proj;
  const user = join(agentNpmDir, "node_modules", pkgName);
  if (existsSync(join(user, "package.json"))) return user;
  return null;
}

/** Label for a package extension entry: `pkg` if at the root index,
 *  `pkg:subpath` otherwise.  Strips a leading `extensions/` and a trailing
 *  `/index.(ts|js)`. */
function packageLabel(absPath: string, baseDir: string, pkgName: string): string {
  let rel = posix.relative(
    baseDir.replace(/\\/g, "/"),
    absPath.replace(/\\/g, "/"),
  );
  if (!rel || rel.startsWith("..") || posix.isAbsolute(rel)) {
    rel = absPath.replace(/\\/g, "/");
  }
  const stripped = rel
    .replace(/^extensions\//, "")
    .replace(/\/index\.(ts|js)$/, "");
  return stripped === rel || stripped === "" ? pkgName : `${pkgName}:${stripped}`;
}

function discoverPackageExtensions(
  pkgSource: string,
  agentNpmDir: string,
  projectNpmDir: string,
  scope: ExtEntry["scope"],
): ExtEntry[] {
  if (!pkgSource.startsWith("npm:")) return [];
  const pkgName = pkgSource.slice("npm:".length).trim();
  if (!pkgName) return [];
  const installDir = resolveNpmInstallPath(pkgName, agentNpmDir, projectNpmDir);
  if (!installDir) return [];
  const pkg = readJsonSafe<PackageManifest>(join(installDir, "package.json"));
  const exts = pkg?.pi?.extensions;
  if (!exts?.length) return [];
  return exts
    .map((rel) => resolve(installDir, rel))
    .filter(existsSync)
    .map((abs) => ({
      key: abs,
      label: packageLabel(abs, installDir, pkgName),
      path: abs,
      source: pkgSource,
      packageKey: pkgSource,
      packageName: pkgName,
      scope,
    }));
}

function discoverExplicit(
  p: string,
  cwd: string,
  scope: ExtEntry["scope"],
): ExtEntry[] {
  const abs = resolve(cwd, p);
  if (!existsSync(abs)) return [];
  if (statSync(abs).isDirectory()) {
    return resolveEntriesInDir(abs).map((f) => makeLocalEntry(f, scope));
  }
  return [makeLocalEntry(abs, scope)];
}

function discoverAllExtensions(cwd: string, agentDir: string) {
  const global =
    readJsonSafe<Settings>(join(agentDir, "settings.json")) ?? {};
  const project =
    readJsonSafe<Settings>(join(cwd, CONFIG_DIR_NAME, "settings.json")) ?? {};
  const projectExtDir = join(cwd, CONFIG_DIR_NAME, "extensions");
  const globalExtDir = join(agentDir, "extensions");
  const projectNpmDir = join(cwd, CONFIG_DIR_NAME, "npm");
  const agentNpmDir = join(agentDir, "npm");

  const entries: ExtEntry[] = [];
  const localPaths: string[] = [];
  const warnings: string[] = [];

  const addLocal = (dir: string, scope: ExtEntry["scope"]) => {
    for (const e of discoverLocalDir(dir, scope)) {
      entries.push({ ...e, label: e.label || basenameOf(e.path, localPaths) });
      localPaths.push(e.path);
    }
  };
  const addExplicit = (p: string, scope: ExtEntry["scope"]) => {
    for (const e of discoverExplicit(p, cwd, scope)) {
      entries.push({
        ...e,
        label: e.label || basenameOf(e.path, [e.path, ...localPaths]),
      });
      localPaths.push(e.path);
    }
  };
  const addPackage = (pkg: string, scope: ExtEntry["scope"]) => {
    if (!pkg.startsWith("npm:")) {
      addExplicit(pkg, scope);
      return;
    }
    const found = discoverPackageExtensions(pkg, agentNpmDir, projectNpmDir, scope);
    if (!found.length) warnings.push(`Package not installed: ${pkg}`);
    entries.push(...found);
  };

  addLocal(projectExtDir, "project");
  addLocal(globalExtDir, "user");
  for (const p of project.extensions ?? []) addExplicit(p, "project");
  for (const p of global.extensions ?? []) addExplicit(p, "user");
  for (const pkg of project.packages ?? []) addPackage(pkg, "project");
  for (const pkg of global.packages ?? []) addPackage(pkg, "user");

  // De-duplicate by key and sort.
  const seen = new Set<string>();
  const deduped = entries.filter((e) => !seen.has(e.key) && seen.add(e.key));
  deduped.sort((a, b) => a.label.localeCompare(b.label));
  return { entries: deduped, warnings };
}

/** Local extension label.
 *
 *  For folder-based extensions (e.g. session-guard/index.ts) the label is the
 *  parent directory name ("session-guard").  For flat files (custom-footer.ts)
 *  the label strips the .ts/.js extension ("custom-footer").  Falls back to
 *  parent-segment prefixes only if two extensions would have the same label. */
function basenameOf(absPath: string, allLocalPaths: string[]): string {
  const segments = absPath.replace(/\\/g, "/").split("/").filter(Boolean);
  const last = segments[segments.length - 1] ?? absPath;

  // folder-based: parent directory name; flat file: strip .ts/.js extension
  const isIndexFile = last === "index.ts" || last === "index.js";
  const base = isIndexFile
    ? (segments[segments.length - 2] ?? last)
    : last.replace(/\.(ts|js)$/, "");

  // Collision detection: check the direct encoding of the label in the path,
  // plus cross-format collisions (flat file vs folder with the same stem).
  //   flat files -> /<base>.ts or /<base>.js
  //   folder     -> /<base>/index.ts or /<base>/index.js
  const nameSuffix = isIndexFile ? "/" + base + "/" + last : "/" + last;
  const collision = allLocalPaths.some(
    (p) => {
      if (p === absPath) return false;
      const normalized = p.replace(/\\/g, "/");
      if (normalized.endsWith(nameSuffix)) return true;
      // Cross-format collision: folder ↔ flat file with same stem
      if (isIndexFile) {
        if (normalized.endsWith("/" + base + ".ts") || normalized.endsWith("/" + base + ".js")) return true;
      } else {
        if (normalized.endsWith("/" + base + "/index.ts") || normalized.endsWith("/" + base + "/index.js")) return true;
      }
      return false;
    },
  );
  if (!collision) return base;
  for (let n = 2; n <= segments.length; n++) {
    const candidate = segments.slice(-n).join("/");
    if (allLocalPaths.every((p) => p === absPath || !p.replace(/\\/g, "/").endsWith("/" + candidate))) {
      return candidate;
    }
  }
  return segments.join("/");
}

// ───────────────────────────────────────────────────────────────────────────
// Resource → entry mapping
//   tools / extension commands: by file path
//   skills / prompt templates:  by package source (first entry with that key)
// ───────────────────────────────────────────────────────────────────────────

function attachRuntimeData(
  rows: ExtRow[],
  tools: { name: string; sourceInfo: { path?: string; source?: string } }[],
  skills: { name: string; sourceInfo: { path?: string; source?: string } }[],
  commands: SlashCommandInfo[],
): void {
  // tools/extension commands → entry by file path (keyByPath)
  // skills/prompt templates  → entry by keyForIgnore:
  //   - package extensions: package source (first entry with that key wins)
  //   - local extensions:   file path (e.key)
  const byPath = new Map<string, ExtRow>();
  const byPackage = new Map<string, ExtRow>();
  for (const e of rows) {
    byPath.set(e.key, e);
    const pkgKey = e.packageKey ?? e.key;
    if (!byPackage.has(pkgKey)) byPackage.set(pkgKey, e);
  }

  for (const t of tools) {
    const k = keyByPath(t.sourceInfo);
    const e = k ? byPath.get(k) : undefined;
    if (e) e._tools.push(t.name);
  }
  for (const s of skills) {
    const k = keyForIgnore(s.sourceInfo);
    const e = k ? byPackage.get(k) : undefined;
    if (e) e._skills.push(s.name);
  }
  for (const c of commands) {
    if (c.source === "extension") {
      const k = keyByPath(c.sourceInfo);
      const e = k ? byPath.get(k) : undefined;
      if (e) e._commands.push(c.name);
    } else if (c.source === "prompt") {
      const k = keyForIgnore(c.sourceInfo);
      const e = k ? byPackage.get(k) : undefined;
      if (e) e._prompts.push(c.name);
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Pattern matching
// ───────────────────────────────────────────────────────────────────────────

function parsePatterns(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function entryMatchesAnyPattern(entry: ExtRow, patterns: string[]): boolean {
  if (!patterns.length) return false;
  const fields = [
    entry.label,
    entry.path,
    entry.packageKey ?? "",
    entry.packageName ?? "",
    entry.source,
    ...entry._tools,
    ...entry._skills,
    ...entry._prompts,
    ...entry._commands,
  ].map((s) => s.toLowerCase());
  return patterns.some((p) => fields.some((f) => f.includes(p)));
}

// ───────────────────────────────────────────────────────────────────────────
// Skills system-prompt rewrite
// ───────────────────────────────────────────────────────────────────────────

const SKILLS_BLOCK_RE =
  /\n\nThe following skills provide specialized instructions for specific tasks\.[\s\S]*?<\/available_skills>/;

function rebuildSkillsInPrompt(systemPrompt: string, skills: Skill[]): string {
  // Only replace the existing <available_skills> block; never append one
  // when the original prompt omitted it (e.g. read is disabled).
  if (!SKILLS_BLOCK_RE.test(systemPrompt)) return systemPrompt;
  return systemPrompt.replace(SKILLS_BLOCK_RE, formatSkillsForPrompt(skills));
}

// ───────────────────────────────────────────────────────────────────────────
// Interactive menu component
// ───────────────────────────────────────────────────────────────────────────

const LABEL_W_MAX = 36;
const RIGHT_COL_W = 40;
/** Width of the cursor + status prefix before the label column. */
const ROW_PREFIX_W = 5; // "→ ●  " / "   ●  "

/** Session entry type used to persist the ignore set across reloads. */
const STATE_ENTRY_TYPE = "ext-mgr-state";

/** Count the tools/skills/prompts owned by the given ignore keys. */
function countForKeys(
  entries: ExtRow[],
  keys: Set<string>,
): { tools: number; skills: number; prompts: number } {
  let tools = 0;
  let skills = 0;
  const prompts = new Set<string>();
  for (const e of entries) {
    if (!keys.has(ignoreKeyForEntry(e))) continue;
    tools += e._tools.length;
    skills += e._skills.length;
    for (const p of e._prompts) prompts.add(p);
  }
  return { tools, skills, prompts: prompts.size };
}

class ExtMenu {
  private selectedIndex = 0;
  private scrollStart = 0;
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(
    private entries: ExtRow[],
    private warnings: string[],
    private staged: Set<string>,
    private keybindings: KeybindingsManager,
    private tui: TUI,
    private theme: Theme,
    private onApply: () => void,
    private onCancel: () => void,
  ) {}

  handleInput(data: string): void {
    const kb = this.keybindings;
    if (kb.matches(data, "tui.select.up")) {
      if (this.entries.length === 0) return;
      this.selectedIndex =
        this.selectedIndex === 0 ? this.entries.length - 1 : this.selectedIndex - 1;
    } else if (kb.matches(data, "tui.select.down")) {
      if (this.entries.length === 0) return;
      this.selectedIndex =
        this.selectedIndex === this.entries.length - 1 ? 0 : this.selectedIndex + 1;
    } else if (kb.matches(data, "tui.select.confirm")) {
      // Enter: apply staged changes and close.
      this.onApply();
      return;
    } else if (kb.matches(data, "tui.select.cancel")) {
      // Esc / Ctrl+C: discard staged changes and close.
      this.onCancel();
      return;
    } else if (data === " ") {
      // Space: toggle the selected extension (SettingsList convention).
      if (this.entries.length === 0) return;
      const key = ignoreKeyForEntry(this.entries[this.selectedIndex]);
      if (this.staged.has(key)) this.staged.delete(key);
      else this.staged.add(key);
    } else {
      return;
    }
    this.invalidate();
    this.tui.requestRender();
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

    const theme = this.theme;
    const lines: string[] = [];

    // Column widths, bounded by the available terminal width.
    const availableLabelW = Math.max(8, width - ROW_PREFIX_W - RIGHT_COL_W - 4);
    const labelW = Math.min(
      LABEL_W_MAX,
      Math.max(8, availableLabelW, ...this.entries.map((e) => Math.min(e.label.length, LABEL_W_MAX))),
    );
    const providesW = Math.max(4, width - ROW_PREFIX_W - labelW - 4);

    // Header (aligned with the label / provides columns).
    lines.push(
      theme.bold(
        `${" ".repeat(ROW_PREFIX_W)}${"Extension".padEnd(labelW)}  Provides`,
      ),
    );
    lines.push(theme.fg("muted", "─".repeat(Math.min(width, ROW_PREFIX_W + labelW + 2 + RIGHT_COL_W))));

    if (this.entries.length === 0) {
      lines.push(theme.fg("muted", `${" ".repeat(ROW_PREFIX_W)}No extensions found`));
    } else {
      // Visible window: leave room for the footer (separator + legend) and
      // scroll indicator.
      const maxVisible = Math.max(
        1,
        Math.min(this.entries.length, (this.tui.terminal?.rows ?? 24) - 8),
      );
      if (this.selectedIndex < this.scrollStart) this.scrollStart = this.selectedIndex;
      if (this.selectedIndex >= this.scrollStart + maxVisible) {
        this.scrollStart = this.selectedIndex - maxVisible + 1;
      }
      const end = Math.min(this.entries.length, this.scrollStart + maxVisible);
      for (let i = this.scrollStart; i < end; i++) {
        lines.push(this.renderRow(this.entries[i], i === this.selectedIndex, labelW, providesW));
      }
      if (this.entries.length > maxVisible) {
        lines.push(
          theme.fg("dim", `  (${this.selectedIndex + 1}/${this.entries.length})`),
        );
      }
    }

    for (const w of this.warnings) lines.push(theme.fg("warning", w));
    lines.push(theme.fg("muted", "─".repeat(Math.min(width, ROW_PREFIX_W + labelW + 2 + RIGHT_COL_W))));

    // Legend — key names follow the configured keybindings (tui.select.*).
    const legend =
      `${theme.fg("success", "●")} enabled   ${theme.fg("warning", "○")} disabled  ` +
      `·  ${keyHint("tui.select.confirm", "apply")}  ·  ${rawKeyHint("space", "toggle")}  ·  ` +
      `${keyHint("tui.select.cancel", "cancel")}`;
    lines.push(truncateToWidth(legend, width, ""));

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  private renderRow(e: ExtRow, selected: boolean, labelW: number, providesW: number): string {
    const theme = this.theme;
    const cursor = selected ? theme.fg("accent", "→") : " ";
    const status = this.staged.has(ignoreKeyForEntry(e))
      ? theme.fg("warning", "○")
      : theme.fg("success", "●");
    const labelCol =
      e.label.length > labelW
        ? e.label.slice(0, labelW - 1) + "…"
        : e.label.padEnd(labelW);
    const labelText = selected ? theme.fg("accent", labelCol) : labelCol;

    const parts: string[] = [];
    if (e._tools.length) parts.push(plural(e._tools.length, "tool"));
    if (e._skills.length) parts.push(plural(e._skills.length, "skill"));
    if (e._prompts.length) parts.push(plural(e._prompts.length, "prompt"));
    if (e._commands.length) parts.push(plural(e._commands.length, "cmd"));
    const provides = parts.join(" \u00b7 ") || "\u2014";

    return `${cursor} ${status}  ${labelText}  ${truncateToWidth(provides, providesW, "")}`;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Extension factory
// ───────────────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ignoreKey set: package sources ("npm:foo") for packages, file paths for local.
  let ignoredKeys: Set<string> = new Set();
  let diagWidgetActive = false;

  pi.registerFlag("ignore-extension", {
    description:
      "Comma-separated name/path patterns of extensions to disable (tools, skills, prompts). May be repeated to add more",
    type: "string",
    default: "",
  });

  // Render the full extension list as a chat entry (fallback for non-TUI
  // modes; the TUI mode shows the interactive menu instead).
  pi.registerEntryRenderer("ext-mgr-list", (entry) => {
    const data = entry.data as { lines: string[] };
    return new Text(data.lines.join("\n"), 1, 0);
  });

  // ── session_start: restore persisted state, then apply CLI flag ─────

  pi.on("session_start", async (_event, ctx) => {
    restoreState(ctx);
    if (ignoredKeys.size) syncActiveTools(ctx);
    const raw = pi.getFlag("ignore-extension");
    if (!raw || raw === true) return;
    // --ignore-extension may be given multiple times (string[]) or contain
    // comma-separated patterns (string).
    applyPatterns(Array.isArray(raw) ? raw : [String(raw)], ctx, true);
  });

  // ── before_agent_start: filter skills from system prompt ─────────────

  pi.on("before_agent_start", async (event) => {
    if (ignoredKeys.size === 0) return;
    const skills = (event.systemPromptOptions.skills ?? []) as Skill[];
    if (!skills.length) return;
    const kept: Skill[] = [];
    let dropped = 0;
    for (const s of skills) {
      const key = keyForIgnore(s.sourceInfo);
      if (key && ignoredKeys.has(key)) dropped++;
      else kept.push(s);
    }
    if (dropped === 0) return;
    const newPrompt = rebuildSkillsInPrompt(event.systemPrompt, kept);
    if (newPrompt !== event.systemPrompt) return { systemPrompt: newPrompt };
  });

  // ── input: block commands owned by ignored extensions ────────────────

  pi.on("input", async (event, ctx) => {
    if (diagWidgetActive) {
      ctx.ui.setWidget("ext-mgr-diag", undefined);
      diagWidgetActive = false;
    }
    if (ignoredKeys.size === 0) return;
    const text = event.text;
    if (!text.startsWith("/")) return;
    const token = text.slice(1).split(/\s/)[0]?.replace(/^\/+/, "");
    if (!token || token === "ext-mgr") return;
    const match = pi.getCommands().find((c) => c.name === token);
    if (!match) return;
    const key = keyForIgnore(match.sourceInfo);
    if (!key || !ignoredKeys.has(key)) return;
    ctx.ui.notify(
      `'/${match.name}' is disabled (owning extension is ignored). Use /ext-mgr reset to restore.`,
      "warning",
    );
    return { action: "handled" };
  });

  // ── before_agent_start: counter extensions that re-add stripped tools ──

  pi.on("before_agent_start", async () => {
    if (ignoredKeys.size === 0) return;
    const keep: string[] = [];
    for (const t of pi.getAllTools()) {
      const key = keyForIgnore(t.sourceInfo);
      if (!(key && ignoredKeys.has(key))) keep.push(t.name);
    }
    if (keep.length !== pi.getActiveTools().length) pi.setActiveTools(keep);
  });

  // ── helpers ──────────────────────────────────────────────────────────

  /** Persist the current ignore set as a session entry so it survives
   *  reloads. Written after every mutation; the latest entry wins on restore. */
  function persistState(ctx: ExtensionContext): void {
    pi.appendEntry(STATE_ENTRY_TYPE, { ignoredKeys: [...ignoredKeys] });
  }

  /** Restore the ignore set from the last persisted entry on the active
   *  branch (same pattern as the /tools example). Stale keys for extensions
   *  that no longer exist are harmless — they just match nothing. */
  function restoreState(ctx: ExtensionContext): void {
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE) continue;
      const data = entry.data as { ignoredKeys?: string[] } | undefined;
      if (Array.isArray(data?.ignoredKeys)) {
        ignoredKeys = new Set(data.ignoredKeys);
      }
    }
  }

  function getEntries(ctx: ExtensionContext) {
    const { entries, warnings } = discoverAllExtensions(ctx.cwd, getAgentDir());
    const rows: ExtRow[] = entries.map(
      (e): ExtRow => ({
        ...e,
        _tools: [],
        _skills: [],
        _prompts: [],
        _commands: [],
      }),
    );
    const cmds = pi.getCommands();
    // Skill commands share the same sourceInfo as the Skill objects in the
    // system prompt; strip the "skill:" prefix to store the bare name.
    const skills = cmds
      .filter((c) => c.source === "skill")
      .map((c) => ({
        name: c.name.startsWith("skill:") ? c.name.slice("skill:".length) : c.name,
        sourceInfo: c.sourceInfo,
      }));
    attachRuntimeData(rows, pi.getAllTools(), skills, cmds);
    // Built-in tools are not extensions and cannot be ignored.
    return { entries: rows, warnings };
  }

  function buildDisableMessage(
    header: string,
    labels: string[],
    counts: { tools: number; skills: number; prompts: number },
  ): string {
    const lines = [header];
    for (const l of labels) lines.push(`  \u00b7 ${l}`);
    const parts: string[] = [];
    if (counts.tools) parts.push(plural(counts.tools, "tool"));
    if (counts.skills) parts.push(plural(counts.skills, "skill"));
    if (counts.prompts) parts.push(plural(counts.prompts, "prompt"));
    if (parts.length) lines.push(parts.join(" \u00b7 "));
    return lines.join("\n");
  }

  /** Recompute the active tool set from the current ignore set and surface
   *  tools that another extension re-stripped as a diagnostic widget. */
  function syncActiveTools(ctx: ExtensionContext): string[] {
    const keep: string[] = [];
    for (const t of pi.getAllTools()) {
      const key = keyForIgnore(t.sourceInfo);
      if (!(key && ignoredKeys.has(key))) keep.push(t.name);
    }
    pi.setActiveTools(keep);

    const stillMissing = keep.filter((n) => !pi.getActiveTools().includes(n));
    if (stillMissing.length) {
      ctx.ui.setWidget(
        "ext-mgr-diag",
        [
          ctx.ui.theme.bold(
            "Some tools were re-stripped by another extension — will force-restore on next turn:",
          ),
          ...stillMissing.map((s) => `  ${s}`),
          "",
          ctx.ui.theme.fg(
            "muted",
            "ext-mgr will re-apply them before your next prompt.",
          ),
        ],
      );
      diagWidgetActive = true;
    } else {
      ctx.ui.setWidget("ext-mgr-diag", undefined);
      diagWidgetActive = false;
    }
    return stillMissing;
  }

  function applyPatterns(raws: string[], ctx: ExtensionContext, fromFlag: boolean): void {
    const patterns: string[] = [];
    for (const raw of raws) patterns.push(...parsePatterns(raw));
    if (!patterns.length) return;
    const { entries } = getEntries(ctx);

    const labels: string[] = [];
    const keys = new Set<string>();
    for (const e of entries) {
      if (entryMatchesAnyPattern(e, patterns)) {
        labels.push(e.label);
        keys.add(ignoreKeyForEntry(e));
      }
    }
    if (!keys.size) {
      ctx.ui.notify(`--ignore-extension: no match for "${patterns.join(", ")}"`, "warning");
      return;
    }

    let added = 0;
    for (const k of keys) {
      if (!ignoredKeys.has(k)) {
        ignoredKeys.add(k);
        added++;
      }
    }
    if (added) persistState(ctx);

    // Remove tools owned by ignored keys, counting as we go.
    const keep: string[] = [];
    let toolsRemoved = 0;
    for (const t of pi.getAllTools()) {
      const key = keyForIgnore(t.sourceInfo);
      if (key && ignoredKeys.has(key)) toolsRemoved++;
      else keep.push(t.name);
    }
    if (toolsRemoved) pi.setActiveTools(keep);

    // Count skills/prompts that will be filtered on the next turn.
    // Deduplicate prompts by name across entries that share a package
    // key, so the count matches the number of distinct prompt templates.
    let skills = 0;
    const seenPrompts = new Set<string>();
    for (const e of entries) {
      if (!ignoredKeys.has(ignoreKeyForEntry(e))) continue;
      skills += e._skills.length;
      for (const p of e._prompts) seenPrompts.add(p);
    }
    const prompts = seenPrompts.size;
    const counts = { tools: toolsRemoved, skills, prompts };

    if (fromFlag && !toolsRemoved && !skills && !prompts) {
      ctx.ui.notify(
        `--ignore-extension: matched "${patterns.join(", ")}" but found no tools/skills/prompts to disable (event-only extensions can only be hidden, not unhooked)`,
        "warning",
      );
      return;
    }
    const header = fromFlag
      ? `Ignored ${added} extension group(s) via --ignore-extension:`
      : `Disabled ${added} extension group(s):`;
    ctx.ui.notify(buildDisableMessage(header, labels, counts), "info");
  }

  /** Apply the staged menu selections: disable keys in `toAdd`, re-enable
   *  keys in `toRemove`, then sync tools and report the delta. */
  function applyMenuSelections(ctx: ExtensionContext, staged: Set<string>): void {
    const { entries } = getEntries(ctx);
    const toAdd = new Set<string>();
    const toRemove = new Set<string>();
    for (const k of staged) if (!ignoredKeys.has(k)) toAdd.add(k);
    for (const k of ignoredKeys) if (!staged.has(k)) toRemove.add(k);
    if (!toAdd.size && !toRemove.size) return;

    for (const k of toAdd) ignoredKeys.add(k);
    for (const k of toRemove) ignoredKeys.delete(k);
    persistState(ctx);

    const stillMissing = syncActiveTools(ctx);
    const lines: string[] = [];
    if (toAdd.size) {
      const labels = entries
        .filter((e) => toAdd.has(ignoreKeyForEntry(e)))
        .map((e) => e.label);
      lines.push(
        buildDisableMessage(
          `Disabled ${toAdd.size} extension group(s):`,
          labels,
          countForKeys(entries, toAdd),
        ),
      );
    }
    if (toRemove.size) {
      const labels = entries
        .filter((e) => toRemove.has(ignoreKeyForEntry(e)))
        .map((e) => e.label);
      lines.push(
        buildDisableMessage(
          `Enabled ${toRemove.size} extension group(s):`,
          labels,
          countForKeys(entries, toRemove),
        ),
      );
    }
    ctx.ui.notify(lines.join("\n"), stillMissing.length ? "warning" : "info");
  }

  function resetAll(ctx: ExtensionContext) {
    const beforeKeys = ignoredKeys.size;
    const beforeTools = pi.getActiveTools().length;
    const allToolNames = pi.getAllTools().map((t) => t.name);

    ignoredKeys = new Set();
    persistState(ctx);
    if (allToolNames.length) pi.setActiveTools(allToolNames);

    const stillMissing = syncActiveTools(ctx);
    ctx.ui.notify(
      `Reset: cleared ${beforeKeys} ignored extension(s); tools ${beforeTools} → ${pi.getActiveTools().length}/${allToolNames.length} active`,
      stillMissing.length ? "warning" : "info",
    );
  }

  /** Fallback for non-TUI modes: render the list as a chat entry
   *  (scrollable, never truncated by the TUI widget area). */
  function renderList(ctx: ExtensionContext) {
    const { entries, warnings } = getEntries(ctx);
    const theme = ctx.ui.theme;

    const labelW = Math.min(
      LABEL_W_MAX,
      Math.max(8, ...entries.map((e) => Math.min(e.label.length, LABEL_W_MAX))),
    );
    const lines: string[] = [];
    lines.push(theme.bold(`  ${"Extension".padEnd(labelW)}  Provides`));
    lines.push(theme.fg("muted", "\u2500".repeat(labelW + RIGHT_COL_W)));
    for (const e of entries) {
      const status = ignoredKeys.has(ignoreKeyForEntry(e))
        ? theme.fg("warning", "\u25cb")
        : theme.fg("success", "\u25cf");
      const labelCol =
        e.label.length > labelW
          ? e.label.slice(0, labelW - 1) + "\u2026"
          : e.label.padEnd(labelW);
      const parts: string[] = [];
      if (e._tools.length) parts.push(plural(e._tools.length, "tool"));
      if (e._skills.length) parts.push(plural(e._skills.length, "skill"));
      if (e._prompts.length) parts.push(plural(e._prompts.length, "prompt"));
      if (e._commands.length) parts.push(plural(e._commands.length, "cmd"));
      lines.push(`${status}  ${labelCol}  ${parts.join(" \u00b7 ") || "\u2014"}`);
    }
    for (const w of warnings) lines.push(theme.fg("warning", w));
    lines.push(theme.fg("muted", "\u2500".repeat(labelW + RIGHT_COL_W)));
    lines.push(
      `${theme.fg("success", "\u25cf")} enabled   ${theme.fg("warning", "\u25cb")} disabled  ${theme.fg("muted", "\u00b7  /ext-mgr <pat> to ignore  \u00b7  /ext-mgr reset to restore")}`,
    );

    pi.appendEntry("ext-mgr-list", { lines });
    ctx.ui.notify(`${entries.length} extension(s) listed in chat`, "info");
  }

  /** TUI: interactive enable/disable menu. Non-TUI: static chat list. */
  function showList(ctx: ExtensionContext) {
    if (ctx.mode !== "tui") {
      renderList(ctx);
      return;
    }
    const { entries, warnings } = getEntries(ctx);
    const staged = new Set(ignoredKeys);

    ctx.ui.custom((tui, theme, keybindings, done) => {
      const menu = new ExtMenu(
        entries,
        warnings,
        staged,
        keybindings,
        tui,
        theme,
        () => {
          applyMenuSelections(ctx, staged);
          done(true);
        },
        () => done(false),
      );
      return menu;
    });
  }

  // ── /ext-mgr command ──────────────────────────────────────────────────

  pi.registerCommand("ext-mgr", {
    description: "Manage enabled/disabled extensions (tools, skills, prompts, commands)",
    handler: async (args, ctx) => {
      const sub = (args ?? "").trim();
      if (sub === "" || sub === "list") {
        showList(ctx);
      } else if (sub === "reset") {
        resetAll(ctx);
      } else {
        // Anything else is treated as a pattern (or comma-separated patterns).
        applyPatterns([sub], ctx, false);
      }
    },
  });
}
