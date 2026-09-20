import { describe, expect, it } from "vitest";
import { join, resolve } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { discoverSkills, parseSkillFrontmatter, skillSearchDirs } from "../src/discovery/skills.js";
import type { RuntimePlugin } from "../src/definition/plugin.js";
import { OpencodeRuntime } from "../runtimes/opencode/runtime.js";
import { ClaudeRuntime, claudeSkillSearchDirs } from "../runtimes/claude/runtime.js";
import { CodexRuntime, codexSkillSearchDirs } from "../runtimes/codex/runtime.js";
import { doctor } from "../src/doctor.js";

const SKILL_MD = [
  "---",
  "name: frontend-design",
  "description: Guidance for distinctive visual design.",
  "license: Complete terms in LICENSE.txt",
  "---",
  "",
  "# Frontend Design",
  "",
  "Body is never surfaced.",
  "",
].join("\n");

function makeSkill(root: string, id: string, body: string = SKILL_MD): string {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), body, "utf-8");
  return dir;
}

describe("parseSkillFrontmatter", () => {
  it("reads name/description and ignores body", () => {
    expect(parseSkillFrontmatter(SKILL_MD)).toEqual({
      name: "frontend-design",
      description: "Guidance for distinctive visual design.",
    });
  });

  it("strips matching quotes", () => {
    const out = parseSkillFrontmatter("---\nname: \"quoted\"\ndescription: 'd'\n---\n");
    expect(out).toEqual({ name: "quoted", description: "d" });
  });

  it("degrades to empty on missing/unclosed frontmatter", () => {
    expect(parseSkillFrontmatter("# no frontmatter\n")).toEqual({});
    expect(parseSkillFrontmatter("---\nname: x\n")).toEqual({});
  });
});

describe("skillSearchDirs", () => {
  it("lists the global root without spawning", () => {
    const dirs = skillSearchDirs({ homeDir: "/tmp/fake-home" });
    expect(dirs).toEqual([join("/tmp/fake-home", ".config", "opencode", "skills")]);
  });

  it("appends the project root when cwd is given", () => {
    const dirs = skillSearchDirs({ homeDir: "/tmp/fake-home", cwd: "/tmp/fake-proj" });
    expect(dirs).toHaveLength(2);
    expect(dirs[1]?.endsWith(join(".opencode", "skills"))).toBe(true);
  });

  it("honors an explicit config dir (XDG)", () => {
    const dirs = skillSearchDirs({ configDir: "/tmp/fake-xdg" });
    expect(dirs).toEqual([join("/tmp/fake-xdg", "opencode", "skills")]);
  });
});

describe("discoverSkills", () => {
  it("finds global + project skills with metadata only", () => {
    const base = mkdtempSync(join(tmpdir(), "agent-runtimes-skills-"));
    try {
      const globalRoot = join(base, "config", "opencode", "skills");
      makeSkill(globalRoot, "frontend-design");
      // No SKILL.md → skipped, never an error.
      mkdirSync(join(globalRoot, "empty-dir"), { recursive: true });
      const projRoot = join(base, "proj", ".opencode", "skills");
      makeSkill(projRoot, "project-helper", "---\nname: Project Helper\n---\nbody\n");
      const out = discoverSkills([globalRoot, projRoot]);
      expect(out.map((s) => s.id).sort()).toEqual(["frontend-design", "project-helper"]);
      const global = out.find((s) => s.id === "frontend-design");
      expect(global).toMatchObject({ name: "frontend-design", source: "global" });
      expect(global?.description).toContain("distinctive visual design");
      expect(global?.path.endsWith("SKILL.md")).toBe(true);
      // Project entry without description stays valid, body not surfaced.
      expect(out.find((s) => s.id === "project-helper")).toMatchObject({
        name: "Project Helper",
        source: "project",
      });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("returns [] for missing roots (fail-open)", () => {
    expect(discoverSkills([join(tmpdir(), "agent-runtimes-nope", "skills")])).toEqual([]);
  });
});

describe("claudeSkillSearchDirs", () => {
  it("lists the global root without spawning", () => {
    expect(claudeSkillSearchDirs({ homeDir: "/tmp/fake-home" })).toEqual([
      { dir: join("/tmp/fake-home", ".claude", "skills"), source: "global" },
    ]);
  });

  it("appends the project root when cwd is given", () => {
    const roots = claudeSkillSearchDirs({ homeDir: "/tmp/fake-home", cwd: "/tmp/fake-proj" });
    expect(roots).toHaveLength(2);
    expect(roots[1]).toEqual({
      dir: resolve("/tmp/fake-proj", ".claude", "skills"),
      source: "project",
    });
  });
});

describe("discoverSkills with explicit roots", () => {
  it("honors the caller-supplied source", () => {
    const base = mkdtempSync(join(tmpdir(), "agent-runtimes-claude-skills-"));
    try {
      const projRoot = join(base, "proj", ".claude", "skills");
      makeSkill(projRoot, "ask-matt");
      const out = discoverSkills([{ dir: projRoot, source: "project" }]);
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ id: "ask-matt", source: "project" });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("ClaudeRuntime.skills", () => {
  it("lists live global skills when installed (frontend-design)", async () => {
    const globalRoot = join(homedir(), ".claude", "skills");
    if (!existsSync(globalRoot)) return;
    const runtime = new ClaudeRuntime();
    const skills = await runtime.skills();
    expect(skills.map((s) => s.id)).toContain("frontend-design");
    expect(skills.every((s) => s.source === "global")).toBe(true);
  });
});

describe("codexSkillSearchDirs", () => {
  it("lists user + .system roots without spawning", () => {
    expect(codexSkillSearchDirs({ homeDir: "/tmp/fake-codex", env: {} })).toEqual([
      { dir: join("/tmp/fake-codex", "skills"), source: "global" },
      { dir: join("/tmp/fake-codex", "skills", ".system"), source: "global" },
    ]);
  });

  it("honors $CODEX_HOME and appends the project root", () => {
    const roots = codexSkillSearchDirs({
      cwd: "/tmp/fake-proj",
      env: { CODEX_HOME: "/tmp/fake-env-home" },
    });
    expect(roots).toHaveLength(3);
    expect(roots[0]?.dir).toBe(join("/tmp/fake-env-home", "skills"));
    expect(roots[2]).toEqual({
      dir: resolve("/tmp/fake-proj", ".codex", "skills"),
      source: "project",
    });
  });

  it("prefers user skills over .system on name clashes", () => {
    const base = mkdtempSync(join(tmpdir(), "agent-runtimes-codex-clash-"));
    try {
      const userRoot = join(base, "home", "skills");
      const systemRoot = join(userRoot, ".system");
      makeSkill(userRoot, "shared", "---\nname: User Shared\n---\n");
      makeSkill(systemRoot, "shared", "---\nname: System Shared\n---\n");
      const out = discoverSkills([
        { dir: userRoot, source: "global" },
        { dir: systemRoot, source: "global" },
      ]);
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ id: "shared", name: "User Shared" });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("CodexRuntime.skills", () => {
  it("lists live system skills when installed (skill-creator)", async () => {
    const globalRoot = join(homedir(), ".codex", "skills");
    if (!existsSync(globalRoot)) return;
    const runtime = new CodexRuntime();
    const skills = await runtime.skills();
    expect(skills.map((s) => s.id)).toContain("skill-creator");
  });
});

describe("OpencodeRuntime.skills", () => {
  it("is callable and returns an array (live env may be empty)", async () => {
    const runtime = new OpencodeRuntime();
    const skills = await runtime.skills();
    expect(Array.isArray(skills)).toBe(true);
  });
});

describe("doctor Skills row", () => {
  it("reports skill metadata through the stub registry", async () => {
    const base = new OpencodeRuntime();
    const runtime = {
      id: base.id,
      info: () => base.info(),
      detect: () => base.detect(),
      createSession: (o?: unknown) =>
        base.createSession(o as Parameters<OpencodeRuntime["createSession"]>[0]),
      capabilities: () => base.capabilities(),
      models: () => Promise.resolve([{ id: "m" }]),
      auth: () => Promise.resolve({ authenticated: true, method: "oauth" as const, detail: "ok" }),
      mcp: () => Promise.resolve([]),
      skills: () =>
        Promise.resolve([
          {
            id: "frontend-design",
            name: "frontend-design",
            source: "global" as const,
            path: "/skills/frontend-design/SKILL.md",
          },
        ]),
      plugins: (): Promise<RuntimePlugin[]> => Promise.resolve([]),
      installs: () => Promise.resolve([]),
    };
    // Stub detect too: the Skills row is the subject, and a real
    // version-probe spawn flakes past 5s under full-suite load.
    runtime.detect = () =>
      Promise.resolve({ installed: true, executable: "/usr/bin/opencode", version: "1.18.27" });
    const report = await doctor("opencode", {
      resolve: () => Promise.resolve(runtime),
    });
    const row = report.checks.find((c) => c.name === "Skills");
    expect(row?.status).toBe("ok");
    expect(row?.detail).toContain("frontend-design");
  });

  it("warns skills-empty through the stub registry", async () => {
    const base = new OpencodeRuntime();
    const runtime = {
      id: base.id,
      info: () => base.info(),
      detect: () => Promise.resolve({ installed: false as const }),
      createSession: (o?: unknown) =>
        base.createSession(o as Parameters<OpencodeRuntime["createSession"]>[0]),
      capabilities: () => base.capabilities(),
      models: () => Promise.resolve([]),
      auth: () =>
        Promise.resolve({ authenticated: false, method: "unknown" as const, detail: "unknown" }),
      mcp: () => Promise.resolve([]),
      skills: () => Promise.resolve([]),
      plugins: (): Promise<RuntimePlugin[]> => Promise.resolve([]),
      installs: () => Promise.resolve([]),
    };
    const report = await doctor("opencode", {
      resolve: () => Promise.resolve(runtime),
    });
    const row = report.checks.find((c) => c.name === "Skills");
    expect(row?.status).toBe("warn");
    expect(row?.reason).toBe("skills-empty");
  });
});
