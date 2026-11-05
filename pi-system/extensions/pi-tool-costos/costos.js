#!/usr/bin/env node
/**
 * @module pi-tool-costos
 * @reads ~/.pi/agent/sessions/
 * @writes ~/workspace/costos/
 * @user-docs ~/workspace/AGENTS.md#costos-de-ia
 *
 * Aggregates the usage/cost that pi already stores per assistant message,
 * tool result and summary in the session JSONL files. The ledger is
 * append-only and deduplicated by entry id + timestamp, so re-scanning the
 * same sessions (or forked/cloned sessions that copied their history) never
 * double-counts a call.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const HOME = process.env.PI_HOME || os.homedir();
const WORKSPACE = process.env.PI_WORKSPACE || path.join(HOME, "workspace");
const DATA_DIR = process.env.COSTOS_DATA_DIR || path.join(WORKSPACE, "costos");
const SESSIONS_DIR =
  process.env.COSTOS_SESSIONS_DIR ||
  process.env.PI_CODING_AGENT_SESSION_DIR ||
  path.join(HOME, ".pi", "agent", "sessions");
const LEDGER = path.join(DATA_DIR, "ledger.jsonl");
const STATE = path.join(DATA_DIR, "state.json");
const TELEBRIDGE = path.join(HOME, ".pi", "agent", "telebridge.json");

const LOCALE = resolveLocale();
const TZ = resolveTimeZone();
const SUBSCRIPTION_PROVIDERS = new Set([
  "kimi-coding",
  "opencode-go",
  "openai-codex",
  "github-copilot",
]);

const DATE_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function resolveLocale() {
  const candidate = process.env.PI_LOCALE || "es-VE";
  try {
    new Intl.DateTimeFormat(candidate);
    return candidate;
  } catch {
    return "es-VE";
  }
}

function resolveTimeZone() {
  const candidates = [
    process.env.COSTOS_TZ,
    process.env.PI_TZ,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    "UTC",
  ].filter(Boolean);

  for (const tz of candidates) {
    try {
      new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format();
      return tz;
    } catch {
      // Try the next candidate.
    }
  }
  return "UTC";
}

function toNum(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function parseTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

function dateKey(ms) {
  const parts = DATE_FMT.formatToParts(new Date(ms));
  const get = (type) => parts.find((part) => part.type === type)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function todayKey() {
  return dateKey(Date.now());
}

function addDays(dateStr, delta) {
  const [year, month, day] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(year, month - 1, day + delta, 12));
  return dt.toISOString().slice(0, 10);
}

function countDays(from, to) {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  const a = Date.UTC(fy, fm - 1, fd, 12);
  const b = Date.UTC(ty, tm - 1, td, 12);
  return Math.round((b - a) / 86_400_000) + 1;
}

function validateDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) {
    throw new Error(`Fecha inválida: ${value || "(vacía)"}. Usá YYYY-MM-DD.`);
  }
  const [year, month, day] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(year, month - 1, day, 12));
  if (dt.toISOString().slice(0, 10) !== value) {
    throw new Error(`Fecha inválida: ${value}.`);
  }
}

function monthLabel(dateStr) {
  const [year, month] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(year, month - 1, 15, 12));
  return new Intl.DateTimeFormat(LOCALE, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(dt);
}

function prettyPath(target) {
  const rel = path.relative(HOME, target);
  if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
    return "~/" + rel.split(path.sep).join("/");
  }
  return target;
}

function usd(value) {
  const n = Number.isFinite(value) ? value : 0;
  const abs = Math.abs(n);
  if (abs === 0) return "$0.00";
  if (abs < 0.01) return `$${n.toFixed(4)}`;
  if (abs < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

function fmtTokens(value) {
  const n = Number.isFinite(value) ? value : 0;
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readState() {
  try {
    const data = JSON.parse(fs.readFileSync(STATE, "utf8"));
    if (
      data &&
      data.version === 1 &&
      data.root === SESSIONS_DIR &&
      data.files
    ) {
      return data;
    }
  } catch {
    // Missing or corrupt cache: a full scan is always safe.
  }
  return { version: 1, root: SESSIONS_DIR, files: {} };
}

function writeState(files) {
  try {
    ensureDataDir();
    fs.writeFileSync(
      STATE,
      JSON.stringify({ version: 1, root: SESSIONS_DIR, files }, null, 2) + "\n",
      "utf8",
    );
  } catch {
    // The cache is an optimization; never fail a scan because of it.
  }
}

function sessionFileKey(file) {
  return path.relative(SESSIONS_DIR, file).split(path.sep).join("/");
}

function listSessionFiles(root) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  const stack = [root];

  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(full);
      }
    }
  }

  return files.sort();
}

function readLedger() {
  if (!fs.existsSync(LEDGER)) {
    return { events: [], keys: new Set() };
  }

  const events = [];
  const keys = new Set();
  const raw = fs.readFileSync(LEDGER, "utf8").replace(/^\uFEFF/, "");

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (!event || !event.key || !event.tokens || !event.cost) continue;
      events.push(event);
      keys.add(event.key);
    } catch {
      // Ignore a partial or corrupt line; it will be re-added on the next scan.
    }
  }

  return { events, keys };
}

function toEvent(entry, header) {
  const message = entry.type === "message" ? entry.message : null;
  let usage = null;
  let source = null;
  let provider = "";
  let model = "";

  if (message && message.role === "assistant" && message.usage) {
    usage = message.usage;
    source = "assistant";
    provider = message.provider || "";
    model = message.responseModel || message.model || "";
  } else if (message && message.role === "toolResult" && message.usage) {
    usage = message.usage;
    source = "tool";
  } else if (
    (entry.type === "compaction" || entry.type === "branch_summary") &&
    entry.usage
  ) {
    usage = entry.usage;
    source = "summary";
  }

  if (!usage) return null;

  const tokens = {
    input: toNum(usage.input),
    output: toNum(usage.output),
    cacheRead: toNum(usage.cacheRead),
    cacheWrite: toNum(usage.cacheWrite),
  };
  tokens.total =
    toNum(usage.totalTokens) ||
    tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;

  const rawCost = usage.cost || {};
  const cost = {
    input: toNum(rawCost.input),
    output: toNum(rawCost.output),
    cacheRead: toNum(rawCost.cacheRead),
    cacheWrite: toNum(rawCost.cacheWrite),
  };
  cost.total = toNum(rawCost.total);
  if (!cost.total) {
    cost.total = cost.input + cost.output + cost.cacheRead + cost.cacheWrite;
  }

  if (tokens.total <= 0 && cost.total <= 0) return null;

  const timestamp = entry.timestamp ?? message?.timestamp ?? header.timestamp;
  const tsMs = parseTimestamp(timestamp);
  if (tsMs === null) return null;
  const ts = new Date(tsMs).toISOString();

  // entry.id and entry.timestamp survive /fork and /clone, so the same call
  // copied into a second session file produces the same key and is counted once.
  const keySource = [
    entry.id || "",
    ts,
    source,
    provider,
    model,
    tokens.total,
    cost.total.toFixed(10),
  ].join("|");
  const key = crypto.createHash("sha256").update(keySource).digest("hex").slice(0, 24);

  return {
    key,
    ts,
    date: dateKey(tsMs),
    source,
    provider,
    model,
    subscription: SUBSCRIPTION_PROVIDERS.has(provider),
    tokens,
    cost,
    session: header.id || "",
  };
}

function scanSessions({ rebuild = false } = {}) {
  if (!fs.existsSync(SESSIONS_DIR)) {
    if (rebuild) {
      throw new Error(`No existe el directorio de sesiones: ${SESSIONS_DIR}`);
    }
    const { events } = readLedger();
    return {
      files: 0,
      parsed: 0,
      skipped: 0,
      sessions: 0,
      newEvents: 0,
      totalEvents: events.length,
      warning: `No existe el directorio de sesiones: ${SESSIONS_DIR}`,
    };
  }

  if (rebuild) {
    ensureDataDir();
    if (fs.existsSync(LEDGER)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      fs.renameSync(LEDGER, `${LEDGER}.bak-${stamp}`);
    }
  }

  const { events, keys } = readLedger();
  const files = listSessionFiles(SESSIONS_DIR);
  const newEvents = [];

  // The cache is only trusted when the ledger has content. If the user deletes
  // or empties the ledger but keeps state.json, the next scan must re-read
  // every session.
  let ledgerHasContent = false;
  try {
    ledgerHasContent = fs.statSync(LEDGER).size > 0;
  } catch {
    // No ledger yet.
  }
  const useCache = !rebuild && ledgerHasContent;
  const previousState = useCache ? readState() : { version: 1, files: {} };
  const nextState = {};

  let parsed = 0;
  let skipped = 0;
  let sessions = 0;

  for (const file of files) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }

    const fileKey = sessionFileKey(file);
    nextState[fileKey] = { size: stat.size, mtimeMs: stat.mtimeMs };

    const cached = previousState.files[fileKey];
    if (
      useCache &&
      cached &&
      cached.size === stat.size &&
      cached.mtimeMs === stat.mtimeMs
    ) {
      skipped++;
      continue;
    }

    parsed++;
    let raw;
    try {
      raw = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    } catch {
      continue;
    }

    let header = {};
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        // Session files are append-only; an incomplete last line is expected
        // while pi is writing. It will be picked up on the next scan.
        continue;
      }

      if (entry.type === "session") {
        header = entry;
        sessions++;
        continue;
      }

      const event = toEvent(entry, header);
      if (!event || keys.has(event.key)) continue;
      keys.add(event.key);
      newEvents.push(event);
    }
  }

  if (newEvents.length) {
    ensureDataDir();
    fs.appendFileSync(
      LEDGER,
      newEvents.map((event) => JSON.stringify(event)).join("\n") + "\n",
      "utf8",
    );
  }

  writeState(nextState);

  return {
    files: files.length,
    parsed,
    skipped,
    sessions,
    newEvents: newEvents.length,
    totalEvents: events.length + newEvents.length,
    warning: null,
  };
}

function filterEvents(events, range) {
  return events.filter(
    (event) =>
      (!range.from || event.date >= range.from) &&
      (!range.to || event.date <= range.to),
  );
}

function aggregate(events) {
  const result = {
    cost: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    calls: 0,
    noPricing: 0,
    subscriptionCalls: 0,
    byModel: new Map(),
    byDay: new Map(),
  };

  for (const event of events) {
    result.calls++;
    result.cost += event.cost.total;
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"]) {
      result.tokens[key] += event.tokens[key] || 0;
    }
    if (event.subscription) {
      result.subscriptionCalls++;
    } else if (event.cost.total === 0 && event.tokens.total > 0) {
      result.noPricing++;
    }

    const modelKey =
      event.source === "assistant"
        ? `${event.provider || "?"}/${event.model || "?"}`
        : "tools/summaries";
    let model = result.byModel.get(modelKey);
    if (!model) {
      model = { key: modelKey, cost: 0, tokens: 0, calls: 0 };
      result.byModel.set(modelKey, model);
    }
    model.cost += event.cost.total;
    model.tokens += event.tokens.total;
    model.calls++;

    let day = result.byDay.get(event.date);
    if (!day) {
      day = { date: event.date, cost: 0, tokens: 0, calls: 0 };
      result.byDay.set(event.date, day);
    }
    day.cost += event.cost.total;
    day.tokens += event.tokens.total;
    day.calls++;
  }

  result.byModel = [...result.byModel.values()].sort(
    (a, b) => b.cost - a.cost || b.tokens - a.tokens || a.key.localeCompare(b.key),
  );
  result.byDay = [...result.byDay.values()].sort((a, b) =>
    a.date.localeCompare(b.date),
  );

  return result;
}

function resolveRange(command, opts) {
  const today = todayKey();

  if (opts.from || opts.to) {
    const from = opts.from || opts.to;
    const to = opts.to || opts.from;
    validateDate(from);
    validateDate(to);
    if (from > to) {
      throw new Error("Rango inválido: --desde es posterior a --hasta.");
    }
    return {
      cmd: command === "detalle" ? "detalle" : "rango",
      from,
      to,
      label: `${from} → ${to}`,
    };
  }

  switch (command) {
    case "hoy":
      return { cmd: command, from: today, to: today, label: `hoy · ${today}` };
    case "ayer": {
      const yesterday = addDays(today, -1);
      return {
        cmd: command,
        from: yesterday,
        to: yesterday,
        label: `ayer · ${yesterday}`,
      };
    }
    case "semana": {
      const from = addDays(today, -6);
      return {
        cmd: command,
        from,
        to: today,
        label: `últimos 7 días · ${from} → ${today}`,
      };
    }
    case "mes": {
      const from = `${today.slice(0, 7)}-01`;
      return { cmd: command, from, to: today, label: monthLabel(today) };
    }
    case "mes-anterior": {
      const firstOfThisMonth = `${today.slice(0, 7)}-01`;
      const lastOfPreviousMonth = addDays(firstOfThisMonth, -1);
      const from = `${lastOfPreviousMonth.slice(0, 7)}-01`;
      return {
        cmd: command,
        from,
        to: lastOfPreviousMonth,
        label: monthLabel(lastOfPreviousMonth),
      };
    }
    case "detalle": {
      const from = addDays(today, -(opts.days - 1));
      return {
        cmd: command,
        from,
        to: today,
        label: `últimos ${opts.days} días · ${from} → ${today}`,
      };
    }
    case "todo":
      return { cmd: command, from: null, to: null, label: "histórico" };
    default:
      throw new Error(`Período desconocido: ${command}`);
  }
}

function renderReport(range, totals, meta) {
  const lines = [`💸 Gasto IA · ${range.label}`, ""];

  if (totals.calls === 0) {
    lines.push("Sin llamadas registradas en este período.");
  } else {
    lines.push(`Total: ${usd(totals.cost)}`);
    lines.push(
      `Tokens: ${fmtTokens(totals.tokens.total)} · in ${fmtTokens(totals.tokens.input)} · out ${fmtTokens(totals.tokens.output)} · cache ${fmtTokens(totals.tokens.cacheRead)}/${fmtTokens(totals.tokens.cacheWrite)}`,
    );
    lines.push(`Llamadas: ${totals.calls}`);

    if (range.cmd === "todo") {
      if (totals.byDay.length) {
        lines.push(
          `Días con actividad: ${totals.byDay.length} · ${totals.byDay[0].date} → ${totals.byDay[totals.byDay.length - 1].date}`,
        );
      }
    } else if (range.from && range.to) {
      const days = countDays(range.from, range.to);
      if (days > 1) {
        lines.push(`Promedio diario: ${usd(totals.cost / days)}`);
        if (range.cmd === "mes") {
          const today = todayKey();
          const year = Number(today.slice(0, 4));
          const month = Number(today.slice(5, 7));
          const daysInMonth = new Date(year, month, 0).getDate();
          const elapsed = Number(today.slice(8, 10));
          lines.push(
            `Proyección del mes: ${usd((totals.cost / Math.max(1, elapsed)) * daysInMonth)}`,
          );
        }
      }
    }
  }

  if (totals.byModel.length) {
    lines.push("", "Por modelo:");
    for (const model of totals.byModel.slice(0, 8)) {
      lines.push(
        `  ${model.key} — ${usd(model.cost)} · ${fmtTokens(model.tokens)} tok · ${model.calls} llamada(s)`,
      );
    }
    if (totals.byModel.length > 8) {
      lines.push(`  … y ${totals.byModel.length - 8} más`);
    }
  }

  if (range.cmd === "detalle" && totals.byDay.length) {
    lines.push("", "Por día:");
    for (const day of totals.byDay) {
      lines.push(
        `  ${day.date} — ${usd(day.cost)} · ${fmtTokens(day.tokens)} tok · ${day.calls} llamada(s)`,
      );
    }
  }

  const notes = [];
  if (totals.noPricing) {
    notes.push(
      `⚠️ ${totals.noPricing} llamada(s) sin costo reportado (modelo sin pricing o gratuito).`,
    );
  }
  if (totals.subscriptionCalls) {
    notes.push(
      `ℹ️ ${totals.subscriptionCalls} llamada(s) de suscripción: el costo es nominal, no gasto real.`,
    );
  }
  if (notes.length) lines.push("", ...notes);

  lines.push("", `Ledger: ${meta.ledgerEvents} evento(s) · ${prettyPath(LEDGER)}`);
  if (meta.scan?.warning) lines.push(`⚠️ ${meta.scan.warning}`);

  return lines.join("\n");
}

function toJson(range, totals, meta) {
  return {
    period: range.cmd,
    label: range.label,
    from: range.from,
    to: range.to,
    currency: "USD",
    total: totals.cost,
    tokens: totals.tokens,
    calls: totals.calls,
    noPricingCalls: totals.noPricing,
    subscriptionCalls: totals.subscriptionCalls,
    byModel: totals.byModel,
    byDay: totals.byDay,
    ledger: { path: LEDGER, events: meta.ledgerEvents },
    generatedAt: new Date().toISOString(),
  };
}

function resolveTelegram() {
  let token = process.env.TELEGRAM_BOT_TOKEN || "";
  let chat = process.env.TELEGRAM_CHAT_ID || "";

  if ((!token || !chat) && fs.existsSync(TELEBRIDGE)) {
    try {
      const config = JSON.parse(fs.readFileSync(TELEBRIDGE, "utf8"));
      token = token || config.botToken || "";
      if (!chat && config.chatId !== null && config.chatId !== undefined) {
        chat = String(config.chatId);
      }
    } catch {
      // Ignore an unreadable bridge config and fall back to env vars.
    }
  }

  return { token, chat };
}

function splitMessage(text, limit = 3_900) {
  const chunks = [];
  let current = "";
  for (const line of text.split("\n")) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > limit && current) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function sendTelegram(text) {
  const { token, chat } = resolveTelegram();
  if (!token || !chat) {
    throw new Error(
      "Telegram no configurado: faltan TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID (o ~/.pi/agent/telebridge.json).",
    );
  }

  const chatId = /^-?\d+$/.test(String(chat)) ? Number(chat) : String(chat);

  for (const chunk of splitMessage(text)) {
    const response = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: chunk,
          disable_web_page_preview: true,
        }),
      },
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
      throw new Error(
        `Telegram respondió ${response.status}: ${data.description || "error desconocido"}`,
      );
    }
  }
}

function printHelp() {
  console.log(`Costos de IA — agrega el usage/cost de las sesiones de pi.

Uso:
  node costos.js [período] [opciones]

Períodos:
  hoy (default) · ayer · semana · mes · mes-anterior · todo · detalle
  YYYY-MM-DD                un día específico

Acciones:
  sync                      escanea sesiones y actualiza el ledger
  rebuild                   reconstruye el ledger desde cero (guarda backup)

Opciones:
  --desde YYYY-MM-DD        inicio de rango personalizado
  --hasta YYYY-MM-DD        fin de rango personalizado
  --dias N                  días para "detalle" (default 14)
  --json                    salida JSON
  --telegram                envía el reporte por Telegram
  -h, --help                esta ayuda

Ejemplos:
  node costos.js
  node costos.js mes
  node costos.js detalle --dias 30
  node costos.js todo --telegram`);
}

function parseArgs(argv) {
  const opts = {
    cmd: null,
    from: null,
    to: null,
    days: 14,
    daysSet: false,
    telegram: false,
    json: false,
    help: false,
  };
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--telegram":
      case "-t":
        opts.telegram = true;
        break;
      case "--json":
        opts.json = true;
        break;
      case "--help":
      case "-h":
        opts.help = true;
        break;
      case "--desde":
      case "--from": {
        const value = argv[++i];
        if (!value) throw new Error(`${arg} requiere una fecha YYYY-MM-DD.`);
        opts.from = value;
        break;
      }
      case "--hasta":
      case "--to": {
        const value = argv[++i];
        if (!value) throw new Error(`${arg} requiere una fecha YYYY-MM-DD.`);
        opts.to = value;
        break;
      }
      case "--dias":
      case "--days": {
        const value = Number.parseInt(argv[++i], 10);
        opts.days = Number.isFinite(value) && value > 0 ? value : 14;
        opts.daysSet = true;
        break;
      }
      case "--rebuild":
        opts.cmd = "rebuild";
        break;
      default:
        if (arg.startsWith("-")) throw new Error(`Opción desconocida: ${arg}`);
        positional.push(arg);
    }
  }

  if (opts.help) return opts;

  const aliases = {
    today: "hoy",
    week: "semana",
    month: "mes",
    "prev-month": "mes-anterior",
    all: "todo",
    history: "todo",
    detail: "detalle",
    details: "detalle",
    help: "ayuda",
  };

  let command = positional.shift() || "hoy";
  command = aliases[command.toLowerCase()] || command.toLowerCase();

  if (command === "detalle" && positional.length && !opts.daysSet) {
    const value = Number.parseInt(positional.shift(), 10);
    if (Number.isFinite(value) && value > 0) {
      opts.days = value;
      opts.daysSet = true;
    }
  }

  if (positional.length) {
    throw new Error(`Argumento desconocido: ${positional[0]}`);
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(command)) {
    opts.from = command;
    opts.to = command;
    command = "rango";
  }

  if (opts.json && opts.telegram) {
    throw new Error("--json y --telegram no se pueden combinar.");
  }

  opts.cmd = opts.cmd || command;
  return opts;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`Error: ${error.message}\n`);
    printHelp();
    process.exitCode = 2;
    return;
  }

  if (opts.help || opts.cmd === "ayuda") {
    printHelp();
    return;
  }

  if (opts.cmd === "sync" || opts.cmd === "rebuild") {
    const result = scanSessions({ rebuild: opts.cmd === "rebuild" });
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (result.warning) console.error(`Aviso: ${result.warning}`);
    console.log(
      `Escaneadas ${result.files} archivo(s) de sesión (${result.parsed} leídos, ${result.skipped} sin cambios) · ${result.newEvents} evento(s) nuevo(s) · ${result.totalEvents} en el ledger`,
    );
    return;
  }

  const range = resolveRange(opts.cmd, opts);
  const scan = scanSessions();
  const { events } = readLedger();
  const totals = aggregate(filterEvents(events, range));
  const meta = { ledgerEvents: events.length, scan };

  if (opts.json) {
    console.log(JSON.stringify(toJson(range, totals, meta), null, 2));
    return;
  }

  const report = renderReport(range, totals, meta);
  console.log(report);

  if (opts.telegram) {
    await sendTelegram(report);
    console.log("\nReporte enviado a Telegram.");
  }
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
