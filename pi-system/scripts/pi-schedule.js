#!/usr/bin/env node
/**
 * pi-schedule.js — deterministic shell jobs on Android's JobScheduler.
 *
 * Agent jobs (need reasoning) stay in pi-cron (`/cron`).
 * Shell jobs (scripts, backups, archives) go here: no LLM, no pi session needed,
 * Android wakes the device, runs the wrapper and releases its wake lock.
 *
 * Usage:
 *   node ~/pi-system/scripts/pi-schedule.js install-defaults
 *   node ~/pi-system/scripts/pi-schedule.js add <name> --command "..." --every 24h
 *   node ~/pi-system/scripts/pi-schedule.js add <name> --script ~/path/job.sh --every 12h
 *   node ~/pi-system/scripts/pi-schedule.js list
 *   node ~/pi-system/scripts/pi-schedule.js status
 *   node ~/pi-system/scripts/pi-schedule.js run <name>
 *   node ~/pi-system/scripts/pi-schedule.js remove <name>
 *
 * Notes:
 * - Requires Termux:API (F-Droid app) and `pkg install termux-api`.
 * - JobScheduler period is approximate; minimum 15 minutes.
 * - Jobs run with `~/.env` sourced, cwd `~/workspace`, and logs in
 *   `~/pi-system/logs/system/<name>.log`.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

const HOME = process.env.PI_HOME || os.homedir();
const AGENT_DIR = path.join(HOME, ".pi", "agent");
const JOBS_DIR = path.join(AGENT_DIR, "jobs");
const REGISTRY = path.join(AGENT_DIR, "pi-jobs.json");
const LOG_DIR = path.join(HOME, "pi-system", "logs", "system");
const TERMUX_BIN = "/data/data/com.termux/files/usr/bin";
const MIN_PERIOD_MS = 15 * 60 * 1000;
const NETWORKS = new Set(["any", "unmetered", "cellular", "not_roaming", "none"]);

const HELP = `pi-schedule — shell jobs con Android JobScheduler (sin LLM)

Uso:
  node ~/pi-system/scripts/pi-schedule.js install-defaults
  node ~/pi-system/scripts/pi-schedule.js add <name> --command "..." --every 24h
  node ~/pi-system/scripts/pi-schedule.js add <name> --script ~/ruta/job.sh --every 12h
  node ~/pi-system/scripts/pi-schedule.js list
  node ~/pi-system/scripts/pi-schedule.js status
  node ~/pi-system/scripts/pi-schedule.js run <name>
  node ~/pi-system/scripts/pi-schedule.js remove <name>

Opciones de add:
  --command "..."        comando a ejecutar (una línea de shell)
  --script <ruta>        script existente a ejecutar
  --every <duración>     intervalo: 30m, 12h, 24h, 7d (default 24h, mínimo 15m)
  --job-id <int>         id de JobScheduler (default: siguiente libre)
  --network <tipo>       any|unmetered|cellular|not_roaming|none (default any)
  --persisted[=bool]     sobrevive reboot (default true)
  --charging[=bool]      solo cargando (default false)
  --battery-not-low[=bool]  solo batería no baja (default true)
  --storage-not-low[=bool]  solo storage no bajo (default false)
  --dry-run              muestra qué haría, sin registrar
  --force                reemplaza un job con el mismo nombre

Requiere Termux:API (app de F-Droid) y \`pkg install termux-api\`.
`;

function die(message) {
  console.error(`pi-schedule: ${message}`);
  process.exit(1);
}

function parseDuration(input) {
  const match = String(input ?? "").trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)$/i);
  if (!match) return null;
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multipliers = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
  };
  return Math.round(value * multipliers[unit]);
}

function formatDuration(ms) {
  if (ms % 604_800_000 === 0) return `${ms / 604_800_000}w`;
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${ms}ms`;
}

function expandHome(p) {
  if (!p) return p;
  if (p === "~") return HOME;
  if (p.startsWith("~/")) return path.join(HOME, p.slice(2));
  return p;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function sanitizeName(name) {
  if (!/^[A-Za-z0-9._-]+$/.test(String(name ?? ""))) {
    die("el nombre solo puede tener letras, números, punto, guion y guion bajo");
  }
  return name;
}

function ensureDirs() {
  fs.mkdirSync(JOBS_DIR, { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function loadRegistry() {
  try {
    const data = JSON.parse(fs.readFileSync(REGISTRY, "utf8"));
    if (!Array.isArray(data.jobs)) return { schema: 1, jobs: [] };
    return { schema: 1, jobs: data.jobs };
  } catch {
    return { schema: 1, jobs: [] };
  }
}

function saveRegistry(registry) {
  fs.mkdirSync(AGENT_DIR, { recursive: true });
  const tmp = `${REGISTRY}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(registry, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, REGISTRY);
}

function schedulerAvailable() {
  const result = spawnSync("sh", ["-c", "command -v termux-job-scheduler"], {
    encoding: "utf8",
  });
  return result.status === 0 && Boolean(result.stdout.trim());
}

function scheduler(args, { dryRun = false } = {}) {
  if (dryRun) {
    console.log(`[dry-run] termux-job-scheduler ${args.join(" ")}`);
    return;
  }
  if (!schedulerAvailable()) {
    die("Termux:API no está disponible. Instalá la app desde F-Droid y ejecutá `pkg install termux-api`.");
  }
  const result = spawnSync("termux-job-scheduler", args, { stdio: "inherit" });
  if (result.error) die(result.error.message);
  if (result.status !== 0) die(`termux-job-scheduler terminó con código ${result.status}`);
}

function wrapperContent(job) {
  const command = job.command;
  return `#!/data/data/com.termux/files/usr/bin/bash
# Generated by pi-schedule for "${job.name}". Do not edit by hand.
export PATH="${TERMUX_BIN}:$PATH"
[ -f "$HOME/.env" ] && . "$HOME/.env"
mkdir -p "$HOME/pi-system/logs/system"
cd "$HOME/workspace" || exit 1
{
  echo "[$(date -Iseconds)] start ${job.name}"
  ${command}
  code=$?
  echo "[$(date -Iseconds)] exit $code"
  exit $code
} >> "$HOME/pi-system/logs/system/${job.name}.log" 2>&1
`;
}

function writeWrapper(job) {
  ensureDirs();
  const wrapper = path.join(JOBS_DIR, `${job.name}.sh`);
  fs.writeFileSync(wrapper, wrapperContent(job), { encoding: "utf8", mode: 0o755 });
  try {
    fs.chmodSync(wrapper, 0o755);
  } catch {
    // Windows / non-POSIX: ignore.
  }
  return wrapper;
}

function addJob(opts) {
  const registry = loadRegistry();
  const existing = registry.jobs.find((j) => j.name === opts.name);
  if (existing && !opts.force) {
    die(`ya existe un job llamado "${opts.name}" (usá --force o remove)`);
  }

  const periodMs = parseDuration(opts.every ?? "24h");
  if (!periodMs) die(`duración inválida: ${opts.every} (ejemplos: 30m, 12h, 24h, 7d)`);
  if (periodMs < MIN_PERIOD_MS) die("JobScheduler exige un mínimo de 15m");
  if (!NETWORKS.has(opts.network)) die(`red inválida: ${opts.network}`);

  let command;
  if (opts.script) {
    const scriptPath = path.resolve(expandHome(opts.script));
    if (!fs.existsSync(scriptPath)) die(`no existe el script: ${scriptPath}`);
    command = shellQuote(scriptPath);
  } else if (opts.command) {
    command = opts.command;
  } else {
    die("falta --command o --script");
  }

  let id = opts.jobId;
  if (id === undefined) {
    id = 1;
    while (registry.jobs.some((j) => j.id === id)) id++;
  }
  if (!Number.isInteger(id) || id < 1) die("--job-id debe ser un entero >= 1");
  const idOwner = registry.jobs.find((j) => j.id === id);
  if (idOwner && idOwner.name !== opts.name) {
    die(`el job-id ${id} ya lo usa "${idOwner.name}"`);
  }

  const job = {
    name: opts.name,
    id,
    periodMs,
    every: formatDuration(periodMs),
    network: opts.network,
    persisted: opts.persisted,
    charging: opts.charging,
    batteryNotLow: opts.batteryNotLow,
    storageNotLow: opts.storageNotLow,
    command,
    script: path.join(JOBS_DIR, `${opts.name}.sh`),
    created: new Date().toISOString(),
  };

  if (opts.dryRun) {
    console.log(`[dry-run] wrapper: ${job.script}`);
    console.log(wrapperContent(job));
    console.log("[dry-run] registro:");
    console.log(JSON.stringify(job, null, 2));
    return job;
  }

  writeWrapper(job);
  scheduler(
    [
      "--script", job.script,
      "--job-id", String(job.id),
      "--period-ms", String(job.periodMs),
      "--network", job.network,
      "--battery-not-low", String(job.batteryNotLow),
      "--storage-not-low", String(job.storageNotLow),
      "--charging", String(job.charging),
      "--persisted", String(job.persisted),
    ],
    { dryRun: false },
  );

  const jobs = registry.jobs.filter((j) => j.name !== job.name);
  jobs.push(job);
  jobs.sort((a, b) => a.id - b.id);
  saveRegistry({ schema: 1, jobs });
  console.log(`✓ ${job.name} cada ${job.every} (job-id ${job.id})`);
  console.log(`  wrapper: ${job.script}`);
  console.log(`  log:     ${path.join(LOG_DIR, `${job.name}.log`)}`);
  return job;
}

function listJobs() {
  const registry = loadRegistry();
  if (registry.jobs.length === 0) {
    console.log("No hay shell jobs registrados. Probá: install-defaults");
    return;
  }
  console.log("ID  NAME                 EVERY   COMMAND");
  for (const job of registry.jobs) {
    const command = job.command.length > 70 ? job.command.slice(0, 67) + "..." : job.command;
    console.log(`${String(job.id).padEnd(3)} ${job.name.padEnd(20)} ${job.every.padEnd(7)} ${command}`);
  }
}

function status() {
  const registry = loadRegistry();
  console.log(`HOME:     ${HOME}`);
  console.log(`registry: ${REGISTRY}`);
  console.log(`jobs:     ${registry.jobs.length}`);
  console.log(`Termux:API: ${schedulerAvailable() ? "✅ disponible" : "❌ falta (app + pkg install termux-api)"}`);
  if (schedulerAvailable()) {
    console.log("\nJobScheduler pendientes:");
    const result = spawnSync("termux-job-scheduler", ["--pending"], { encoding: "utf8" });
    process.stdout.write(result.stdout || result.stderr || "(sin salida)\n");
  }
}

function removeJob(name) {
  const registry = loadRegistry();
  const job = registry.jobs.find((j) => j.name === name);
  if (!job) die(`no existe el job "${name}"`);
  scheduler(["--cancel", "--job-id", String(job.id)], { dryRun: false });
  try {
    fs.unlinkSync(job.script);
  } catch {
    // Wrapper already gone.
  }
  saveRegistry({ schema: 1, jobs: registry.jobs.filter((j) => j.name !== name) });
  console.log(`✓ ${name} cancelado`);
}

function runJob(name) {
  const registry = loadRegistry();
  const job = registry.jobs.find((j) => j.name === name);
  if (!job) die(`no existe el job "${name}"`);
  if (!fs.existsSync(job.script)) die(`falta el wrapper: ${job.script}`);
  const result = spawnSync("bash", [job.script], { stdio: "inherit" });
  process.exit(result.status ?? 1);
}

function installDefaults() {
  const registry = loadRegistry();
  if (registry.jobs.some((j) => j.name === "archivar-memoria")) {
    console.log("archivar-memoria ya está registrado.");
    return;
  }
  const command = 'node "$HOME/pi-system/extensions/pi-tool-archive/archive-session.js"';
  addJob({
    name: "archivar-memoria",
    command,
    every: "24h",
    jobId: 1,
    network: "none",
    persisted: true,
    charging: false,
    batteryNotLow: true,
    storageNotLow: false,
    dryRun: false,
    force: false,
  });
  console.log("\nAhora deshabilitá/quitá la entrada archivar-memoria de ~/.pi/agent/pi-cron.tab.");
}

function parseArgs(argv) {
  const opts = {
    network: "any",
    every: "24h",
    persisted: true,
    charging: false,
    batteryNotLow: true,
    storageNotLow: false,
    dryRun: false,
    force: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [flag, inline] = arg.includes("=") ? arg.split(/=(.*)/s, 2) : [arg, undefined];
    const next = () => {
      if (inline !== undefined) return inline;
      if (i + 1 >= argv.length) die(`falta valor para ${arg}`);
      return argv[++i];
    };
    const bool = (def) => {
      if (inline === undefined) return def;
      if (inline === "true") return true;
      if (inline === "false") return false;
      die(`valor booleano inválido para ${flag}: ${inline}`);
    };

    switch (flag) {
      case "--command": opts.command = next(); break;
      case "--script": opts.script = next(); break;
      case "--every": opts.every = next(); break;
      case "--job-id": opts.jobId = Number(next()); break;
      case "--network": opts.network = next(); break;
      case "--persisted": opts.persisted = bool(true); break;
      case "--no-persisted": opts.persisted = false; break;
      case "--charging": opts.charging = bool(true); break;
      case "--no-charging": opts.charging = false; break;
      case "--battery-not-low": opts.batteryNotLow = bool(true); break;
      case "--allow-low-battery": opts.batteryNotLow = false; break;
      case "--storage-not-low": opts.storageNotLow = bool(true); break;
      case "--allow-low-storage": opts.storageNotLow = false; break;
      case "--dry-run": opts.dryRun = true; break;
      case "--force": opts.force = true; break;
      case "-h":
      case "--help": opts.help = true; break;
      default:
        if (arg.startsWith("-")) die(`opción desconocida: ${arg}`);
        opts.positional = opts.positional ?? [];
        opts.positional.push(arg);
    }
  }
  return opts;
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "-h" || command === "--help") {
    console.log(HELP);
    return;
  }

  switch (command) {
    case "add": {
      const opts = parseArgs(rest);
      const name = opts.positional?.[0];
      if (!name) die("falta el nombre del job");
      if (opts.help) { console.log(HELP); return; }
      addJob({ ...opts, name: sanitizeName(name) });
      break;
    }
    case "list": listJobs(); break;
    case "status": status(); break;
    case "run": {
      const name = rest[0];
      if (!name) die("falta el nombre del job");
      runJob(name);
      break;
    }
    case "remove": {
      const name = rest[0];
      if (!name) die("falta el nombre del job");
      removeJob(name);
      break;
    }
    case "install-defaults": {
      const opts = parseArgs(rest);
      if (opts.dryRun) {
        addJob({
          name: "archivar-memoria",
          command: 'node "$HOME/pi-system/extensions/pi-tool-archive/archive-session.js"',
          every: "24h",
          jobId: 1,
          network: "none",
          persisted: true,
          charging: false,
          batteryNotLow: true,
          storageNotLow: false,
          dryRun: true,
          force: false,
        });
      } else {
        installDefaults();
      }
      break;
    }
    default:
      die(`comando desconocido: ${command}`);
  }
}

main();
