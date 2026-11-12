import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { loadConfig, saveConfig, resolveToken, resolveChatId } from "./config.js";
import { startBot, stopBot, getBot, setAllowedChatId, setIncomingMessageHandler, setIncomingVoiceHandler, setIncomingPhotoHandler, setIncomingDocumentHandler, waitForChatId, startTyping, stopTyping, sendTextWithRetry, sendVoice } from "./bot.js";
import { markdownToTelegramHtml, splitForTelegram } from "./formatter.js";

const TELEGRAM_BRIEF_INSTRUCTION = [
	"The user is reading this on a phone via Telegram.",
	"Be very concise: short paragraphs, no big code blocks unless asked.",
	"Summarize actions taken rather than showing full output.",
	"Use plain language, skip formatting-heavy content.",
	"",
	"--- ElevenLabs / Voice ---",
	"If the user sent a voice message, transcribe it before responding:",
	"  node ~/pi-system/extensions/pi-tool-elevenlabs/elevenlabs.js stt /path/to/audio.ogg",
	"",
	"If the user asks for an audio reply or TTS, generate it and send it via Telegram:",
	"  node ~/pi-system/extensions/pi-tool-elevenlabs/elevenlabs.js tts '<text>' --voice <id> --output ~/workspace/tmp/audio.mp3",
	"  node ~/pi-system/extensions/pi-tool-elevenlabs/send-telegram-voice.js ~/workspace/tmp/audio.mp3",
	"",
	"List available voices:",
	"  node ~/pi-system/extensions/pi-tool-elevenlabs/elevenlabs.js voices",
].join("\n");

interface TelegramPending {
	chatId: number;
	text: string;
}

// Dedupe identical outbound messages for a short window. `turn_end` sends the
// final answer and `agent_end` is a fallback; without this guard the fallback
// can resend the same text. Cron events emitted twice are also collapsed here.
// Module scope (not the extension factory) so duplicate extension instances in
// the same process share the guard.
const OUTBOUND_DEDUPE_MS = 15_000;
const recentOutbound = new Map<string, number>();

function isRecentlySent(key: string): boolean {
	const now = Date.now();
	for (const [k, at] of recentOutbound) {
		if (now - at > OUTBOUND_DEDUPE_MS) recentOutbound.delete(k);
	}
	const last = recentOutbound.get(key);
	return last !== undefined && now - last < OUTBOUND_DEDUPE_MS;
}

function markRecentlySent(key: string) {
	recentOutbound.set(key, Date.now());
}

export default function (pi: ExtensionAPI) {
	let relayEnabled = false;
	let chatId: number | null = null;
	let botToken: string | null = null;
	let notifyToolsEnabled = true;

	// Async turn-tracking state
	const telegramQueue: TelegramPending[] = [];
	let activeTurnChatId: number | null = null;

	// Coalesce rapid-fire Telegram messages into one agent turn. This avoids
	// multiple turns (and multiple identical final answers) when the user sends
	// a thought split across two or three messages.
	const TELEGRAM_COALESCE_MS = 1500;
	let incomingBuffer: {
		chatId: number;
		parts: string[];
		ctx: ExtensionContext;
		timer: ReturnType<typeof setTimeout>;
	} | null = null;

	// ── Setup Flow ──────────────────────────────────────────────

	async function runSetup(ctx: ExtensionCommandContext): Promise<boolean> {
		// 1. Resolve bot token
		botToken = resolveToken();
		if (!botToken) {
			const input = await ctx.ui.input("Enter your Telegram bot token (from @BotFather):");
			if (!input || !input.trim()) {
				ctx.ui.notify("Setup cancelled — no token provided", "warning");
				return false;
			}
			botToken = input.trim();
		}

		// 2. Start bot
		ctx.ui.notify("Starting Telegram bot...", "info");
		try {
			await startBot(botToken);
		} catch (err: any) {
			ctx.ui.notify(`Failed to start bot: ${err.message}`, "error");
			botToken = null;
			return false;
		}

		// 3. Resolve chat ID
		chatId = resolveChatId();
		if (!chatId) {
			ctx.ui.notify("Send any message to your bot on Telegram to link your chat...", "info");
			chatId = await waitForChatId();
			ctx.ui.notify(`Chat ID discovered: ${chatId}`, "info");
		}

		// 4. Load persisted settings
		const config = loadConfig();
		notifyToolsEnabled = config?.notifyTools ?? true;

		// 5. Persist config
		saveConfig({ botToken, chatId, notifyTools: notifyToolsEnabled });
		setAllowedChatId(chatId);

		// 6. Wire up incoming message handler
		wireIncomingHandler(ctx);

		ctx.ui.notify(`✅ Telegram connected! Chat ID: ${chatId}`, "info");
		return true;
	}

	function isSetUp(): boolean {
		return getBot() !== null && chatId !== null;
	}

	// ── Incoming Message Handler ────────────────────────────────

	function clearIncomingBuffer() {
		if (incomingBuffer) {
			clearTimeout(incomingBuffer.timer);
			incomingBuffer = null;
		}
	}

	function flushIncomingBuffer() {
		const buffer = incomingBuffer;
		if (!buffer) return;
		incomingBuffer = null;
		clearTimeout(buffer.timer);
		if (!relayEnabled) return;

		const text = buffer.parts.join("\n");
		telegramQueue.push({ chatId: buffer.chatId, text });
		if (buffer.ctx.isIdle()) {
			pi.sendUserMessage(text);
		} else {
			pi.sendUserMessage(text, { deliverAs: "steer" });
		}
	}

	function enqueueTelegramMessage(chatId: number, text: string, ctx: ExtensionContext) {
		if (!relayEnabled) {
			sendTextWithRetry(chatId, "⚠️ Relay is disabled. Enable with /telegram in pi.");
			return;
		}

		// Notify in TUI
		if (ctx.hasUI) {
			ctx.ui.notify(`📱 Telegram: ${text.length > 60 ? text.slice(0, 60) + "…" : text}`, "info");
		}

		// Coalesce bursts: two messages sent seconds apart are one thought.
		if (incomingBuffer && incomingBuffer.chatId !== chatId) {
			flushIncomingBuffer();
		}
		if (!incomingBuffer) {
			incomingBuffer = {
				chatId,
				parts: [],
				ctx,
				timer: setTimeout(flushIncomingBuffer, TELEGRAM_COALESCE_MS),
			};
		} else {
			clearTimeout(incomingBuffer.timer);
			incomingBuffer.timer = setTimeout(flushIncomingBuffer, TELEGRAM_COALESCE_MS);
		}
		incomingBuffer!.parts.push(text);
	}

	function wireIncomingHandler(ctx: ExtensionContext) {
		setIncomingMessageHandler((_incomingChatId, text) => {
			enqueueTelegramMessage(_incomingChatId, text, ctx);
		});

		setIncomingVoiceHandler((_incomingChatId, filePath, duration) => {
			if (!relayEnabled) {
				sendTextWithRetry(_incomingChatId, "⚠️ Relay is disabled. Enable with /telegram in pi.");
				return;
			}

			if (ctx.hasUI) {
				ctx.ui.notify(`🎤 Telegram: voice message (${duration}s) saved to ${filePath}`, "info");
			}

			const text = `[Voice message received: ${filePath}]`;
			enqueueTelegramMessage(_incomingChatId, text, ctx);
		});

		setIncomingPhotoHandler((_incomingChatId, filePath, caption) => {
			if (!relayEnabled) {
				sendTextWithRetry(_incomingChatId, "⚠️ Relay is disabled. Enable with /telegram in pi.");
				return;
			}

			if (ctx.hasUI) {
				ctx.ui.notify(`📷 Telegram: photo received → ${filePath}`, "info");
			}

			const text = caption
				? `[Photo received: ${filePath}] ${caption}`
				: `[Photo received: ${filePath}]`;
			enqueueTelegramMessage(_incomingChatId, text, ctx);
		});

		setIncomingDocumentHandler((_incomingChatId, filePath, fileName, caption) => {
			if (!relayEnabled) {
				sendTextWithRetry(_incomingChatId, "⚠️ Relay is disabled. Enable with /telegram in pi.");
				return;
			}

			if (ctx.hasUI) {
				ctx.ui.notify(`📄 Telegram: document received → ${fileName}`, "info");
			}

			const text = caption
				? `[Document received: ${filePath}] ${caption}`
				: `[Document received: ${filePath}]`;
			enqueueTelegramMessage(_incomingChatId, text, ctx);
		});
	}

	// ── Relay Toggle ────────────────────────────────────────────

	async function enableRelay(ctx: ExtensionContext) {
		relayEnabled = true;
		pi.appendEntry("telebridge-state", { enabled: true });

		if (ctx.hasUI) {
			const theme = ctx.ui.theme;
			ctx.ui.setStatus("telebridge", theme.fg("success", "📡 TG"));
			ctx.ui.notify("🟢 Telegram relay enabled", "info");
		}

		if (chatId) {
			await sendTextWithRetry(chatId, "📡 Connected to pi session");
		}
	}

	async function disableRelay(ctx: ExtensionContext) {
		relayEnabled = false;
		clearIncomingBuffer();
		pi.appendEntry("telebridge-state", { enabled: false });

		if (ctx.hasUI) {
			ctx.ui.setStatus("telebridge", undefined);
			ctx.ui.notify("🔴 Telegram relay disabled", "info");
		}

		if (chatId) {
			await sendTextWithRetry(chatId, "📴 Disconnected from pi session");
		}
	}

	// ── Commands ────────────────────────────────────────────────

	pi.registerCommand("telegram", {
		description: "Toggle Telegram relay (setup | status | on/off | tools)",
		handler: async (args, ctx) => {
			const subcommand = args?.trim().toLowerCase();

			if (subcommand === "setup") {
				await runSetup(ctx);
				return;
			}

			if (subcommand === "status") {
				const botRunning = getBot() !== null;
				const cfg = loadConfig();
				const lines = [
					`Bot: ${botRunning ? "✅ running" : "❌ stopped"}`,
					`Chat ID: ${chatId ?? "not set"}`,
					`Relay: ${relayEnabled ? "🟢 enabled" : "🔴 disabled"}`,
					`Tool notifications: ${notifyToolsEnabled ? "🟢 on" : "🔴 off"}`,
					`Autostart on session: ${cfg?.autoEnable ? "🟢 on" : "🔴 off"}`,
				];
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			if (subcommand === "autostart") {
				const cfg = loadConfig();
				if (!cfg) {
					ctx.ui.notify("Run /telegram setup first", "warning");
					return;
				}
				const next = !(cfg.autoEnable ?? false);
				saveConfig({ ...cfg, autoEnable: next });
				ctx.ui.notify(`Autostart on session: ${next ? "🟢 on" : "🔴 off"}`, "info");
				return;
			}

			if (subcommand === "tools") {
				notifyToolsEnabled = !notifyToolsEnabled;
				const config = loadConfig();
				if (config) {
					saveConfig({ ...config, notifyTools: notifyToolsEnabled });
				}
				ctx.ui.notify(`Tool notifications ${notifyToolsEnabled ? "🟢 enabled" : "🔴 disabled"}`, "info");
				if (chatId) {
					await sendTextWithRetry(chatId, `🔧 Tool notifications ${notifyToolsEnabled ? "enabled" : "disabled"}`);
				}
				return;
			}

			// Toggle: set up first if needed
			if (!isSetUp()) {
				const ok = await runSetup(ctx);
				if (!ok) return;
			}

			// Toggle relay
			if (relayEnabled) {
				await disableRelay(ctx);
			} else {
				await enableRelay(ctx);
			}
		},
	});

	// ── Turn Tracking ───────────────────────────────────────────

	pi.on("input", async (event) => {
		// Only bind & drain when no turn is currently active. If a turn is active,
		// the queued message will be picked up at the next message_start (steering)
		// or at turn_end of the active turn — whichever fires first. Never drop
		// chatIds: doing so silently loses the response when a message arrives
		// during the transition between turn_end and the next turn_start.
		if (event.source !== "extension") return;
		if (telegramQueue.length === 0) return;
		if (activeTurnChatId !== null) return;
		const pending = telegramQueue.shift()!;
		activeTurnChatId = pending.chatId;
		console.log("[telebridge] Turn bound via input to Telegram chat:", activeTurnChatId);
	});

	pi.on("message_start", async (event) => {
		// Bind queued messages to the new turn when input didn't already do it
		// (e.g. steering/followUp delivery paths). Only consume from the queue
		// if we can actually bind — never drop a chatId.
		if (event.message.role !== "user") return;
		if (telegramQueue.length === 0) return;
		if (activeTurnChatId !== null) return;

		const messageText = extractUserMessageText(event.message);
		if (!messageText) return;

		const index = telegramQueue.findIndex(
			(p) => messageText.includes(p.text) || p.text.includes(messageText)
		);
		if (index === -1) return;

		const pending = telegramQueue.splice(index, 1)[0];
		activeTurnChatId = pending.chatId;
		console.log("[telebridge] Turn bound via message_start to Telegram chat:", activeTurnChatId);
	});

	pi.on("before_agent_start", async (event) => {
		if (!relayEnabled || activeTurnChatId === null) return;
		return {
			systemPrompt: event.systemPrompt + "\n\n" + TELEGRAM_BRIEF_INSTRUCTION,
		};
	});

	pi.on("turn_start", async () => {
		if (relayEnabled && activeTurnChatId !== null) {
			startTyping(activeTurnChatId);
		}
	});

	pi.on("tool_execution_start", async (event) => {
		if (!relayEnabled || !notifyToolsEnabled || activeTurnChatId === null) return;
		const summary = formatToolSummary(event.toolName, event.args);
		if (summary) {
			await sendTextWithRetry(activeTurnChatId, `🔧 ${summary}`);
		}
	});

	pi.on("turn_end", async (event) => {
		if (!relayEnabled || activeTurnChatId === null) return;

		const msg = event.message;
		if (msg.role !== "assistant") return;

		const assistantText = extractAssistantText(msg);
		const hasToolCalls = event.toolResults && event.toolResults.length > 0;

		if (assistantText.trim()) {
			await sendAssistantResponse(activeTurnChatId, assistantText);
		}

		// Only clear the binding if this turn didn't spawn more tool calls.
		// If there are tool calls, another turn with the final response is coming.
		if (!hasToolCalls) {
			activeTurnChatId = null;
			stopTyping();
			// If a Telegram message arrived while this turn was generating its
			// final response, its chatId is still in the queue. Bind it now so
			// the next turn (which pi-mono is about to start for the queued
			// steer/followUp) targets the right chat instead of being dropped.
			if (telegramQueue.length > 0) {
				const next = telegramQueue.shift()!;
				activeTurnChatId = next.chatId;
				console.log("[telebridge] Re-bound to next queued chat after turn_end:", activeTurnChatId);
			}
		}
	});

	// Fallback: if turn_end didn't fire (error/abort), agent_end will catch it
	pi.on("agent_end", async (event) => {
		if (!relayEnabled || activeTurnChatId === null) return;

		const targetChatId = activeTurnChatId;
		activeTurnChatId = null;

		const messages = event.messages ?? [];
		let assistantText = "";

		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role === "assistant") {
				assistantText = extractAssistantText(msg);
				break;
			}
		}

		if (!assistantText.trim()) {
			console.log("[telebridge] agent_end fallback: no assistant text found");
			stopTyping();
			return;
		}

		// `turn_end` already sent this exact final message: do not resend it.
		const dedupeKey = `assistant:${targetChatId}:${assistantText.trim()}`;
		if (isRecentlySent(dedupeKey)) {
			stopTyping();
			return;
		}

		console.log("[telebridge] agent_end fallback triggered for chat:", targetChatId);
		stopTyping();
		await sendAssistantResponse(targetChatId, assistantText);
	});

	// ── Cron → Telegram (outgoing) ────────────────────────────

	pi.events.on("cron:job_complete", async (event: any) => {
		if (!relayEnabled || !chatId) return;

		// The same cron completion can reach this handler from more than one
		// process/path. Collapse identical results for a short window.
		const cronKey = `cron:${chatId}:${event.job?.name ?? "cron"}:${event.ok ? "ok" : "err"}:${event.response ?? event.error ?? ""}`;
		if (isRecentlySent(cronKey)) return;
		// Mark before sending: cron events can arrive back-to-back and the
		// handler is async. This collapses them even if the first send is slow.
		markRecentlySent(cronKey);

		const prefix = event.ok ? "✅" : "❌";
		let text = `${prefix} Cron "${event.job.name}" completed (${(event.durationMs / 1000).toFixed(1)}s)`;

		if (event.error) {
			text += `\n\nError:\n${event.error}`;
		} else if (event.response) {
			let response = String(event.response).trimStart();
			const injectedPrompt = (event.job?.prompt ?? event.prompt ?? "").trim();
			if (injectedPrompt && response.startsWith(injectedPrompt)) {
				response = response.slice(injectedPrompt.length).trimStart();
			}
			if (response) {
				text += `\n\n${response}`;
			}
		}

		const chunks = splitForTelegram(text);
		for (const chunk of chunks) {
			try {
				await sendTextWithRetry(chatId, chunk);
			} catch {
				// Silent fail
			}
		}
	});

	// ── Session Events ──────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		stopTyping();
		await stopBot();
		clearIncomingBuffer();
		relayEnabled = false;
		telegramQueue.length = 0;
		activeTurnChatId = null;
		if (ctx.hasUI) {
			ctx.ui.setStatus("telebridge", undefined);
		}

		const cfg = loadConfig();
		if (!cfg?.autoEnable) return;

		// Headless sessions (cron subprocesses, one-shot runs) must not start a
		// second Telegram poller or relay. The interactive session owns Telegram;
		// cron results reach it through `cron:job_complete`.
		if (!ctx.hasUI) return;

		const token = resolveToken();
		const persistedChat = resolveChatId();
		if (!token || !persistedChat) {
			if (ctx.hasUI) {
				ctx.ui.notify("Telegram autostart skipped — token or chat ID missing", "warning");
			}
			return;
		}

		try {
			botToken = token;
			chatId = persistedChat;
			notifyToolsEnabled = cfg.notifyTools ?? true;
			await startBot(token);
			setAllowedChatId(persistedChat);
			wireIncomingHandler(ctx);
			await enableRelay(ctx);
		} catch (err: any) {
			if (ctx.hasUI) {
				ctx.ui.notify(`Telegram autostart failed: ${err.message}`, "warning");
			}
		}
	});

	pi.on("session_before_switch", async (_event, ctx) => {
		stopTyping();
		clearIncomingBuffer();
		if (relayEnabled && chatId) {
			await sendTextWithRetry(chatId, "📴 Session switching...");
		}
		await stopBot();
		relayEnabled = false;
		telegramQueue.length = 0;
		activeTurnChatId = null;
		if (ctx.hasUI) {
			ctx.ui.setStatus("telebridge", undefined);
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopTyping();
		clearIncomingBuffer();
		if (relayEnabled && chatId) {
			await sendTextWithRetry(chatId, "📴 pi session ended");
		}
		await stopBot();
		relayEnabled = false;
		telegramQueue.length = 0;
		activeTurnChatId = null;
		if (ctx.hasUI) {
			ctx.ui.setStatus("telebridge", undefined);
		}
	});

	// ── Helpers ─────────────────────────────────────────────────

	function extractAssistantText(msg: any): string {
		if (!msg) return "";
		if (typeof msg.content === "string") {
			return msg.content;
		}
		if (Array.isArray(msg.content)) {
			return msg.content
				.filter((block: any) => block.type === "text")
				.map((block: any) => block.text)
				.join("\n");
		}
		return "";
	}

	function extractUserMessageText(msg: any): string {
		if (!msg || msg.role !== "user") return "";
		if (typeof msg.content === "string") {
			return msg.content;
		}
		if (Array.isArray(msg.content)) {
			return msg.content
				.filter((block: any) => block.type === "text")
				.map((block: any) => block.text)
				.join("");
		}
		return "";
	}

	async function sendAssistantResponse(targetChatId: number, assistantText: string) {
		const normalized = assistantText.trim();
		if (!normalized) return;

		// `turn_end` is the primary sender; `agent_end` is the error/abort
		// fallback. Both can carry the same final assistant message, so skip an
		// identical send inside a short window.
		const dedupeKey = `assistant:${targetChatId}:${normalized}`;
		if (isRecentlySent(dedupeKey)) return;

		const html = markdownToTelegramHtml(normalized);
		const chunks = splitForTelegram(html);
		let allSent = true;

		for (const chunk of chunks) {
			const ok = await sendTextWithRetry(targetChatId, chunk, "HTML");
			if (!ok) {
				allSent = false;
				break;
			}
		}

		// If HTML parsing/sending fails, fall back to plain text. Short messages
		// are one chunk in practice; long ones are rare in Telegram mode.
		if (!allSent) {
			const ok = await sendTextWithRetry(targetChatId, normalized.slice(0, 4096));
			if (!ok) {
				console.error("[telebridge] Failed to send response to Telegram");
				return;
			}
		}

		markRecentlySent(dedupeKey);
	}

	function formatToolSummary(toolName: string, args: any): string | null {
		try {
			switch (toolName) {
				case "bash":
					return `bash: ${args.command ?? ""}`;
				case "read":
					return `read: ${args.path ?? ""}`;
				case "edit":
					return `edit: ${args.path ?? ""}`;
				case "write":
					return `write: ${args.path ?? ""}`;
				case "grep":
					return `grep: "${args.pattern ?? ""}" ${args.path ?? ""}`;
				case "find":
					return `find: ${args.path ?? ""}`;
				case "ls":
					return `ls: ${args.path ?? ""}`;
				default:
					return `${toolName}: ${JSON.stringify(args).slice(0, 80)}`;
			}
		} catch {
			return `${toolName}: ...`;
		}
	}
}
