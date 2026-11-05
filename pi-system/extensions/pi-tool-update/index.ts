/**
 * pi-tool-update - /update command for the personal agent.
 *
 * Runs ~/pi-system/scripts/pi-update.sh, which updates the repo checkout, the
 * pi CLI (with the Termux shebang repair), local extension dependencies, and
 * the model catalog. The command only orchestrates; all update logic lives in
 * the shell script so it can also be run from a plain SSH session.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 20 * 60 * 1000;

function resolveBash(): string | null {
  if (process.env.PI_BASH) return process.env.PI_BASH;
  if (process.platform === "win32") {
    const candidates = [
      "C:\\Program Files\\Git\\bin\\bash.exe",
      "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
    ];
    return candidates.find((candidate) => existsSync(candidate)) ?? null;
  }
  return "bash";
}

type Ctx = {
  hasUI?: boolean;
  ui: {
    confirm(title: string, message: string): Promise<boolean>;
    notify(message: string, level?: "info" | "warning" | "error"): void;
    setStatus(key: string, text?: string): void;
  };
};

function parseArgs(raw: string): { args: string[]; error?: string } {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  const args: string[] = [];

  for (const token of tokens) {
    switch (token) {
      case "check":
      case "--check":
        args.push("--check");
        break;
      case "models":
        args.push("--models");
        break;
      case "self":
        args.push("--self");
        break;
      case "extensions":
      case "ext":
        args.push("--extensions");
        break;
      case "repo":
        args.push("--repo");
        break;
      case "all":
        args.push("--all");
        break;
      case "--force":
      case "force":
        args.push("--force");
        break;
      case "--yes":
      case "-y":
        // The command already asked for confirmation.
        break;
      default:
        return { args, error: `Unknown option: ${token}` };
    }
  }

  return { args };
}

function tail(text: string, lines = 14): string {
  const clean = text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
  return clean.trim().split(/\r?\n/).slice(-lines).join("\n");
}

export default function (pi: any) {
  pi.registerCommand("update", {
    description: "Update pi, the agent repo, extensions and model catalog",
    handler: async (rawArgs: string, ctx: Ctx) => {
      const parsed = parseArgs(rawArgs ?? "");
      if (parsed.error) {
        ctx.ui.notify(
          `${parsed.error}\nUsage: /update [check|models|self|extensions|repo|all] [--force]`,
          "warning",
        );
        return;
      }

      const home = process.env.PI_HOME || homedir();
      const script = join(home, "pi-system", "scripts", "pi-update.sh");
      const bash = resolveBash();
      const isCheck = parsed.args.includes("--check");

      if (!bash) {
        ctx.ui.notify(
          "No bash found. On Windows install Git Bash or set PI_BASH to a bash executable.",
          "error",
        );
        return;
      }
      if (!existsSync(script)) {
        ctx.ui.notify(`Update script not found: ${script}`, "error");
        return;
      }

      if (ctx.hasUI && typeof ctx.ui.confirm === "function") {
        const ok = await ctx.ui.confirm(
          isCheck ? "Check for updates?" : "Update the agent?",
          isCheck
            ? "Runs a read-only update check. Nothing is written."
            : [
                "This updates:",
                "  - the pi CLI (Termux shebang is repaired automatically)",
                "  - the pi-personal-agent git checkout (only if clean)",
                "  - local extension dependencies",
                "  - the model catalog (OpenCode Go included)",
                "",
                "If user mode is active it is temporarily switched to dev and restored.",
                "Restart pi after the update to run the new version.",
              ].join("\n"),
        );
        if (!ok) return;
      }

      ctx.ui.setStatus?.("pi-update", isCheck ? "Checking updates..." : "Updating agent...");
      try {
        const { stdout, stderr } = await execFileAsync(
          bash,
          [script, ...parsed.args, "--yes", "--json"],
          {
            cwd: home,
            timeout: TIMEOUT_MS,
            maxBuffer: 16 * 1024 * 1024,
            env: { ...process.env, PI_UPDATE_FROM_AGENT: "1" },
          },
        );
        const output = tail([stdout, stderr].filter(Boolean).join("\n"));
        ctx.ui.notify(
          isCheck
            ? `Update check finished.\n${output}`
            : `Update finished. Restart pi to load the new version.\n${output}`,
          "info",
        );
      } catch (error: any) {
        const output = tail(
          [error?.stdout, error?.stderr, error?.message].filter(Boolean).join("\n"),
        );
        ctx.ui.notify(
          `Update failed. The previous version is still usable.\n${output}`,
          "error",
        );
      } finally {
        ctx.ui.setStatus?.("pi-update", undefined);
      }
    },
  });
}
