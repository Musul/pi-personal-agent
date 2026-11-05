/**
 * pi-tool-costos — /costos command for the personal agent.
 *
 * The heavy lifting lives in costos.js so the same report can be produced from
 * a plain SSH session. This extension only validates the arguments and calls
 * the CLI with the current process environment (PI_HOME, TELEGRAM_*, etc.).
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 2 * 60 * 1000;

const COMMANDS = new Set([
  "hoy",
  "ayer",
  "semana",
  "mes",
  "mes-anterior",
  "todo",
  "detalle",
  "sync",
  "rebuild",
  "ayuda",
  "today",
  "week",
  "month",
  "prev-month",
  "all",
  "history",
  "detail",
  "details",
  "help",
]);

const FLAGS = new Set(["--telegram", "--json"]);
const VALUE_FLAGS = new Set(["--desde", "--hasta", "--dias", "--from", "--to", "--days"]);

type Ctx = {
  ui: {
    notify(message: string, level?: "info" | "warning" | "error"): void;
    setStatus?(key: string, text?: string): void;
  };
};

function resolveScript(): string {
  const candidates = [
    fileURLToPath(new URL("./costos.js", import.meta.url)),
    join(process.env.PI_HOME || homedir(), "pi-system", "extensions", "pi-tool-costos", "costos.js"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

function parseArgs(raw: string): string[] {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  const args: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    if (FLAGS.has(token)) {
      args.push(token);
      continue;
    }

    if (VALUE_FLAGS.has(token)) {
      const value = tokens[++i];
      if (!value) throw new Error(`${token} requiere un valor.`);
      args.push(token, value);
      continue;
    }

    if (COMMANDS.has(token.toLowerCase())) {
      args.push(token.toLowerCase());
      continue;
    }

    if (/^\d{4}-\d{2}-\d{2}$/.test(token)) {
      args.push(token);
      continue;
    }

    if (/^\d+$/.test(token)) {
      args.push(token);
      continue;
    }

    throw new Error(
      `Argumento no válido: ${token}\n` +
        "Uso: /costos [hoy|ayer|semana|mes|mes-anterior|todo|detalle] " +
        "[--dias N] [--telegram] [--desde YYYY-MM-DD] [--hasta YYYY-MM-DD]",
    );
  }

  return args;
}

export default function (pi: any) {
  const script = resolveScript();

  pi.registerCommand("costos", {
    description: "AI spend report from pi session usage (hoy|semana|mes|todo|detalle)",
    handler: async (rawArgs: string, ctx: Ctx) => {
      let args: string[];
      try {
        args = parseArgs(rawArgs ?? "");
      } catch (error: any) {
        ctx.ui.notify(error?.message ?? String(error), "warning");
        return;
      }

      ctx.ui.setStatus?.("pi-costos", "Calculando gasto de IA...");
      try {
        const { stdout, stderr } = await execFileAsync(
          process.execPath,
          [script, ...args],
          {
            timeout: TIMEOUT_MS,
            maxBuffer: 8 * 1024 * 1024,
            env: process.env,
          },
        );
        const output = [stdout, stderr].filter(Boolean).join("\n").trim();
        ctx.ui.notify(output || "Sin datos de gasto todavía.", "info");
      } catch (error: any) {
        const output = [error?.stdout, error?.stderr, error?.message]
          .filter(Boolean)
          .join("\n")
          .trim();
        ctx.ui.notify(`No pude calcular el gasto.\n${output}`, "error");
      } finally {
        ctx.ui.setStatus?.("pi-costos", undefined);
      }
    },
  });
}
