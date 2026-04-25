#!/usr/bin/env node
/**
 * @module pi-tool-archive
 * @writes ~/workspace/memory/ (últimos 7d), ~/pi-system/logs/sessions/archives/ (>7d auto-movidos)
 * @user-docs ~/workspace/AGENTS.md#archivo-de-sesiones
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

const HOME = process.env.PI_HOME || os.homedir();
const SESSIONS_ROOT = path.join(HOME, ".pi/agent/sessions");
const MEMORY_DIR = path.join(HOME, "workspace/memory");
const LOG_ARCHIVE_DIR = path.join(HOME, "pi-system/logs/sessions/archives");
const TZ = process.env.PI_TZ || "UTC";
const USER_LABEL = process.env.PI_USER_LABEL || "User";
const AGENT_LABEL = process.env.PI_AGENT_LABEL || "Agent";
const MS_24H = 24 * 60 * 60 * 1000;
const MEMORY_RETENTION_MS = 7 * MS_24H;

function getWorkspaceSessionDir() {
	const entries = fs.readdirSync(SESSIONS_ROOT);
	const dir = entries.find((e) => e.includes("workspace") && fs.statSync(path.join(SESSIONS_ROOT, e)).isDirectory());
	if (!dir) throw new Error("No workspace session directory found");
	return path.join(SESSIONS_ROOT, dir);
}

const SESSIONS_DIR = getWorkspaceSessionDir();

function rotateOldMemory() {
	if (!fs.existsSync(MEMORY_DIR)) return;
	if (!fs.existsSync(LOG_ARCHIVE_DIR)) fs.mkdirSync(LOG_ARCHIVE_DIR, { recursive: true });
	const cutoff = Date.now() - MEMORY_RETENTION_MS;
	for (const f of fs.readdirSync(MEMORY_DIR)) {
		const src = path.join(MEMORY_DIR, f);
		const stat = fs.statSync(src);
		if (!stat.isFile()) continue;
		if (stat.mtimeMs < cutoff) {
			const dst = path.join(LOG_ARCHIVE_DIR, f);
			fs.renameSync(src, dst);
		}
	}
}

function findLatestSession() {
	if (!fs.existsSync(SESSIONS_DIR)) {
		console.error("Sessions directory not found:", SESSIONS_DIR);
		return null;
	}
	const files = fs
		.readdirSync(SESSIONS_DIR)
		.filter((f) => {
			const p = path.join(SESSIONS_DIR, f);
			return fs.statSync(p).isFile();
		})
		.map((f) => {
			const p = path.join(SESSIONS_DIR, f);
			return { name: f, path: p, mtime: fs.statSync(p).mtime };
		})
		.sort((a, b) => b.mtime - a.mtime);
	return files[0] || null;
}

function parseMessages(filePath) {
	const lines = fs.readFileSync(filePath, "utf-8").trim().split("\n");
	const messages = [];

	for (const line of lines) {
		if (!line.trim()) continue;
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}

		if (entry.type !== "message" || !entry.message) continue;

		const msg = entry.message;
		if (msg.role !== "user" && msg.role !== "assistant") continue;

		const parts = [];
		const toolCalls = [];

		if (Array.isArray(msg.content)) {
			for (const c of msg.content) {
				if (c.type === "text" && c.text) {
					parts.push(c.text);
				} else if (c.type === "toolCall" && c.name) {
					toolCalls.push(c.name);
				}
			}
		}

		const text = parts.join("\n").trim();
		if (msg.role === "assistant" && !text) continue;
		if (!text && toolCalls.length === 0) continue;

		// Usar timestamp interno del mensaje (unix ms), fallback al de la entry
		const rawTs = msg.timestamp || entry.timestamp;
		const unixMs = typeof rawTs === "number" ? rawTs : new Date(rawTs).getTime();

		messages.push({
			role: msg.role,
			text,
			toolCalls,
			unixMs,
		});
	}

	return messages;
}

function fmtTime(unixMs) {
	return new Date(unixMs).toLocaleTimeString((process.env.PI_LOCALE || "es-VE"), {
		timeZone: TZ,
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	});
}

function generateMarkdown(messages, sessionFile) {
	const now = Date.now();
	const cutoff = now - MS_24H;

	const recent = messages.filter((m) => m.unixMs >= cutoff);
	const hasRecent = recent.length > 0;
	const targetMessages = hasRecent ? recent : messages;

	const dateStr = new Date().toLocaleDateString((process.env.PI_LOCALE || "es-VE"), {
		timeZone: TZ,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	});

	let md = `# Memoria de sesión — ${dateStr}\n\n`;
	md += `- **Archivo fuente:** \`${sessionFile}\`\n`;
	md += `- **Generado:** ${fmtTime(now)}\n`;
	md += `- **Mensajes en sesión:** ${messages.length}\n`;
	md += `- **Mensajes en últimas 24h:** ${recent.length}\n\n`;
	md += `---\n\n`;

	if (!hasRecent) {
		const lastMsg = messages[messages.length - 1];
		md += `> ⚠️ **Advertencia:** No hubo mensajes en las últimas 24h. `;
		md += `Última actividad: ${fmtTime(lastMsg?.unixMs || 0)}.\n\n`;
		md += `> A continuación se muestra el contexto completo de la sesión activa:\n\n`;
		md += `---\n\n`;
	}

	for (const msg of targetMessages) {
		const time = fmtTime(msg.unixMs);

		if (msg.role === "user") {
			md += `### 🧑‍💻 ${USER_LABEL} (${time})\n\n${msg.text}\n\n`;
		} else {
			md += `### 🤖 ${AGENT_LABEL} (${time})\n\n${msg.text}\n\n`;
			if (msg.toolCalls.length > 0) {
				md += `*Tools: ${msg.toolCalls.join(", ")}*\n\n`;
			}
		}
	}

	return md;
}

function exportHtml(sessionPath, outputDir, date) {
	const htmlPath = path.join(outputDir, `${date}.html`);
	const result = spawnSync("pi", ["--export", sessionPath, htmlPath], {
		encoding: "utf-8",
		timeout: 30000,
	});
	if (result.status === 0) {
		return htmlPath;
	}
	console.error("HTML export failed:", result.stderr);
	return null;
}

// ── Main ─────────────────────────────────────────────────────

const latest = findLatestSession();
if (!latest) {
	console.error("No session files found.");
	process.exit(1);
}

const messages = parseMessages(latest.path);
if (messages.length === 0) {
	console.error("No parseable messages in session.");
	process.exit(1);
}

const md = generateMarkdown(messages, latest.name);

if (!fs.existsSync(MEMORY_DIR)) {
	fs.mkdirSync(MEMORY_DIR, { recursive: true });
}

try { rotateOldMemory(); } catch (e) { console.error("rotateOldMemory failed:", e.message); }

const today = new Date().toLocaleDateString("en-CA", { timeZone: TZ });

function getUniquePath(dir, baseName, ext) {
	let candidate = path.join(dir, `${baseName}${ext}`);
	if (!fs.existsSync(candidate)) return candidate;
	for (let i = 0; i < 26; i++) {
		const suffix = String.fromCharCode(97 + i); // a, b, c...
		candidate = path.join(dir, `${baseName}-${suffix}${ext}`);
		if (!fs.existsSync(candidate)) return candidate;
	}
	throw new Error("Too many archives for today");
}

const mdPath = getUniquePath(MEMORY_DIR, today, ".md");
fs.writeFileSync(mdPath, md, "utf-8");
console.log("Markdown saved:", mdPath);

const htmlBase = path.basename(mdPath, ".md");
const htmlPath = exportHtml(latest.path, MEMORY_DIR, htmlBase);
if (htmlPath) {
	console.log("HTML backup:", htmlPath);
}

console.log("Done.");
