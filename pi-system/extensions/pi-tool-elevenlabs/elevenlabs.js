#!/usr/bin/env node
/**
 * ElevenLabs CLI — STT + TTS
 *
 * Uso:
 *   elevenlabs.js stt <archivo> [--model scribe_v2] [--language eng]
 *   elevenlabs.js tts <texto>   [--voice <id>] [--output <path>] [--model eleven_multilingual_v2]
 *   elevenlabs.js voices
 *
 * Requiere: ELEVENLABS_API_KEY
 */

import fs from "node:fs";
import path from "node:path";

const API_KEY = process.env.ELEVENLABS_API_KEY;
const BASE_URL = "https://api.elevenlabs.io/v1";

if (!API_KEY) {
	console.error("Error: ELEVENLABS_API_KEY no está configurada.");
	process.exit(1);
}

// ── Helpers ─────────────────────────────────────────────────

function parseArgs(raw) {
	const positional = [];
	const options = {};
	for (let i = 0; i < raw.length; i++) {
		if (raw[i].startsWith("--")) {
			const key = raw[i].slice(2);
			const val = raw[i + 1];
			options[key] = val !== undefined && !val.startsWith("--") ? val : true;
			if (val !== undefined && !val.startsWith("--")) i++;
		} else {
			positional.push(raw[i]);
		}
	}
	return { positional, options };
}

// ── STT ─────────────────────────────────────────────────────

async function stt(filePath, opts) {
	const absPath = path.resolve(filePath);
	if (!fs.existsSync(absPath)) {
		throw new Error(`Archivo no encontrado: ${absPath}`);
	}

	const fileBuffer = fs.readFileSync(absPath);
	const fileName = path.basename(absPath);

	const form = new FormData();
	form.append("file", new Blob([fileBuffer]), fileName);
	form.append("model_id", opts.model || "scribe_v2");
	if (opts.language) form.append("language_code", opts.language);

	const res = await fetch(`${BASE_URL}/speech-to-text`, {
		method: "POST",
		headers: { "xi-api-key": API_KEY },
		body: form,
	});

	if (!res.ok) {
		const errText = await res.text();
		throw new Error(`STT error ${res.status}: ${errText}`);
	}

	const data = await res.json();
	if (!data.text) {
		throw new Error("STT devolvió una respuesta vacía.");
	}

	console.log(data.text);
}

// ── TTS ─────────────────────────────────────────────────────

async function tts(text, opts) {
	const voiceId = opts.voice || "21m00Tcm4TlvDq8ikWAM"; // Rachel
	const model = opts.model || "eleven_multilingual_v2";
	const outputPath = opts.output
		? path.resolve(opts.output)
		: path.join(process.cwd(), `elevenlabs_tts_${Date.now()}.mp3`);

	const res = await fetch(`${BASE_URL}/text-to-speech/${voiceId}`, {
		method: "POST",
		headers: {
			"xi-api-key": API_KEY,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			text,
			model_id: model,
			output_format: "mp3_44100_128",
		}),
	});

	if (!res.ok) {
		const errText = await res.text();
		throw new Error(`TTS error ${res.status}: ${errText}`);
	}

	const buffer = Buffer.from(await res.arrayBuffer());
	fs.writeFileSync(outputPath, buffer);
	console.log(outputPath);
}

// ── Voices ──────────────────────────────────────────────────

async function voices() {
	const res = await fetch(`${BASE_URL}/voices`, {
		headers: { "xi-api-key": API_KEY },
	});

	if (!res.ok) {
		const errText = await res.text();
		throw new Error(`Voices error ${res.status}: ${errText}`);
	}

	const data = await res.json();
	for (const v of data.voices) {
		const labels = v.labels
			? Object.entries(v.labels)
					.map(([k, val]) => `${k}:${val}`)
					.join(", ")
			: "";
		console.log(`${v.voice_id}\t${v.name}\t${v.category || "default"}\t${labels}`);
	}
}

// ── CLI ─────────────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0];
const { positional, options } = parseArgs(args.slice(1));

if (!command) {
	console.log(`Uso: elevenlabs.js <stt|tts|voices> [args] [options]

Comandos:
  stt  <archivo>              Transcribe audio a texto
       --model <id>            Modelo STT (default: scribe_v2)
       --language <code>       Código de idioma ISO-639-1/3

  tts  <texto>                Genera audio a partir de texto
       --voice <id>            ID de voz (default: 21m00Tcm4TlvDq8ikWAM)
       --output <path>         Ruta de salida (default: ./elevenlabs_tts_<ts>.mp3)
       --model <id>            Modelo TTS (default: eleven_multilingual_v2)

  voices                      Lista las voces disponibles
`);
	process.exit(0);
}

try {
	switch (command) {
		case "stt": {
			const [filePath] = positional;
			if (!filePath) {
				console.error("Uso: elevenlabs.js stt <archivo> [--model ...] [--language ...]");
				process.exit(1);
			}
			await stt(filePath, options);
			break;
		}
		case "tts": {
			const text = positional.join(" ");
			if (!text) {
				console.error("Uso: elevenlabs.js tts <texto> [--voice ...] [--output ...]");
				process.exit(1);
			}
			await tts(text, options);
			break;
		}
		case "voices": {
			await voices();
			break;
		}
		default:
			console.error(`Comando desconocido: ${command}`);
			process.exit(1);
	}
} catch (err) {
	console.error(err.message);
	process.exit(1);
}
