/**
 * 系统提示增强
 *
 * 根据当前项目的技术栈自动注入相关规范到系统提示。
 * 检测 package.json / Cargo.toml / go.mod / pyproject.toml 等，
 * 注入对应的技术栈提示，让 agent 更懂你的项目。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export interface TechStack {
  languages: string[];
  frameworks: string[];
  packageManager: string;
  testRunner: string;
  lintCommand: string;
  buildCommand: string;
  typeCheckCommand: string;
}

interface PackageJsonLike {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

function hasDependency(deps: Record<string, string>, names: string[]): boolean {
  return names.some((name) => deps[name] !== undefined);
}

function scriptCommand(packageManager: string, scripts: Record<string, string> | undefined, names: string[]): string {
  if (!scripts) return "";
  for (const name of names) {
    if (typeof scripts[name] === "string") return `${packageManager} run ${name}`;
  }
  return "";
}

function detectNodeLanguage(cwd: string, deps: Record<string, string>): "TypeScript" | "JavaScript" {
  if (existsSync(path.join(cwd, "tsconfig.json")) || hasDependency(deps, ["typescript", "vue-tsc"])) {
    return "TypeScript";
  }
  return "JavaScript";
}

export function detectTechStack(cwd: string): TechStack | null {
  const stack: TechStack = {
    languages: [],
    frameworks: [],
    packageManager: "",
    testRunner: "",
    lintCommand: "",
    buildCommand: "",
    typeCheckCommand: "",
  };

  // Node.js / TypeScript / JavaScript
  const pkgPath = path.join(cwd, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as PackageJsonLike;
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };

      stack.languages.push(detectNodeLanguage(cwd, deps));
      stack.packageManager = existsSync(path.join(cwd, "pnpm-lock.yaml"))
        ? "pnpm"
        : existsSync(path.join(cwd, "yarn.lock"))
          ? "yarn"
          : "npm";

      // 框架检测
      if (hasDependency(deps, ["vue", "@vue/runtime-core"])) {
        stack.frameworks.push("Vue");
        if (deps["nuxt"]) stack.frameworks.push("Nuxt");
      }
      if (hasDependency(deps, ["react", "react-dom"])) {
        stack.frameworks.push("React");
        if (deps["next"]) stack.frameworks.push("Next.js");
      }
      if (deps["svelte"]) stack.frameworks.push("Svelte");
      if (deps["angular"] || deps["@angular/core"]) stack.frameworks.push("Angular");
      if (deps["express"]) stack.frameworks.push("Express");
      if (deps["fastify"]) stack.frameworks.push("Fastify");
      if (deps["nestjs"] || deps["@nestjs/core"]) stack.frameworks.push("NestJS");

      // 只注入 package.json 中真实存在的脚本，避免提示不存在的命令。
      stack.testRunner = scriptCommand(stack.packageManager, pkg.scripts, ["test"]);
      stack.lintCommand = scriptCommand(stack.packageManager, pkg.scripts, ["lint"]);
      stack.typeCheckCommand = scriptCommand(stack.packageManager, pkg.scripts, ["type-check", "typecheck"]);
      stack.buildCommand = scriptCommand(stack.packageManager, pkg.scripts, ["build"]);
    } catch {
      // 忽略解析错误
    }
  }

  // Rust
  if (existsSync(path.join(cwd, "Cargo.toml"))) {
    stack.languages.push("Rust");
    stack.packageManager = "cargo";
    stack.testRunner = "cargo test";
    stack.lintCommand = "cargo clippy";
    stack.buildCommand = "cargo build";
  }

  // Go
  if (existsSync(path.join(cwd, "go.mod"))) {
    stack.languages.push("Go");
    stack.packageManager = "go";
    stack.testRunner = "go test ./...";
    stack.buildCommand = "go build ./...";
  }

  // Python
  if (existsSync(path.join(cwd, "pyproject.toml")) || existsSync(path.join(cwd, "setup.py"))) {
    stack.languages.push("Python");
    stack.packageManager = existsSync(path.join(cwd, "Pipfile")) ? "pipenv" : "pip";
    if (existsSync(path.join(cwd, "poetry.lock"))) stack.packageManager = "poetry";
  }

  if (stack.languages.length === 0) return null;
  return stack;
}

export default function (pi: ExtensionAPI) {
  let lastCwd = "";

  pi.on("before_agent_start", async (event, ctx) => {
    // 只在 cwd 变化时重新检测
    if (ctx.cwd === lastCwd) return;
    lastCwd = ctx.cwd;

    const stack = detectTechStack(ctx.cwd);
    if (!stack) return;

    const lines: string[] = ["\n\n## 项目技术栈自动检测\n"];

    if (stack.languages.length > 0) {
      lines.push(`- 语言: ${stack.languages.join(", ")}`);
    }
    if (stack.frameworks.length > 0) {
      lines.push(`- 框架: ${stack.frameworks.join(", ")}`);
    }
    if (stack.packageManager) {
      lines.push(`- 包管理器: ${stack.packageManager}`);
    }

    lines.push("");
    lines.push("相关命令:");
    if (stack.typeCheckCommand) lines.push(`- 类型检查: \`${stack.typeCheckCommand}\``);
    if (stack.lintCommand) lines.push(`- 代码检查: \`${stack.lintCommand}\``);
    if (stack.testRunner) lines.push(`- 运行测试: \`${stack.testRunner}\``);
    if (stack.buildCommand) lines.push(`- 构建: \`${stack.buildCommand}\``);

    lines.push("");
    lines.push("代码修改后优先运行类型检查和 lint，确保不引入错误。");

    event.systemPrompt += lines.join("\n");
  });
}
