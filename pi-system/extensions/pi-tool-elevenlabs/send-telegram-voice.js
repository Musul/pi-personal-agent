#!/usr/bin/env node
/**
 * Send a voice/audio message to Telegram via HTTP API.
 * Reads bot token and chat ID from ~/.pi/agent/telebridge.json
 *
 * Uso:
 *   send-telegram-voice.js <archivo-de-audio>
 *
 * Requiere que la extensión telebridge haya hecho setup al menos una vez.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const CONFIG_FILE = path.join(os.homedir(), ".pi", "agent", "telebridge.json");

function loadConfig() {
	try {
		return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
	} catch {
		return null;
	}
}

const config = loadConfig();
if (!config || !config.botToken || !config.chatId) {
	console.error("Error: telebridge no está configurado. Corré /telegram setup en pi primero.");
	process.exit(1);
}

const args = process.argv.slice(2);
let caption = "";
let filePath = "";
for (let i = 0; i < args.length; i++) {
	if (args[i] === "--caption" && args[i + 1]) {
		caption = args[i + 1];
		i++;
	} else if (!filePath) {
		filePath = args[i];
	}
}
if (!filePath) {
	console.error("Uso: send-telegram-voice.js <archivo-de-audio> [--caption 'texto']");
	process.exit(1);
}

const absPath = path.resolve(filePath);
if (!fs.existsSync(absPath)) {
	console.error(`Error: archivo no encontrado: ${absPath}`);
	process.exit(1);
}

const fileBuffer = fs.readFileSync(absPath);
const fileName = path.basename(absPath);

const form = new FormData();
form.append("chat_id", String(config.chatId));
form.append("voice", new Blob([fileBuffer]), fileName);
if (caption) form.append("caption", caption);

const url = `https://api.telegram.org/bot${config.botToken}/sendVoice`;

fetch(url, { method: "POST", body: form })
	.then(async (res) => {
		if (!res.ok) {
			const text = await res.text();
			throw new Error(`HTTP ${res.status}: ${text}`);
		}
		return res.json();
	})
	.then((data) => {
		if (!data.ok) {
			throw new Error(`Telegram API error: ${data.description}`);
		}
		console.log("Voice sent successfully");
	})
	.catch((err) => {
		console.error("Error:", err.message);
		process.exit(1);
	});
