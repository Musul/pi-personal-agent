import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export interface TelebridgeConfig {
	botToken: string;
	chatId: number | null;
	notifyTools?: boolean;
}

const CONFIG_DIR = path.join(os.homedir(), ".pi", "agent");
const CONFIG_FILE = path.join(CONFIG_DIR, "telebridge.json");

export function loadConfig(): TelebridgeConfig | null {
	try {
		const raw = fs.readFileSync(CONFIG_FILE, "utf-8");
		const data = JSON.parse(raw);
		if (typeof data.botToken === "string") {
			return {
				botToken: data.botToken,
				chatId: typeof data.chatId === "number" ? data.chatId : null,
				notifyTools: typeof data.notifyTools === "boolean" ? data.notifyTools : undefined,
			};
		}
		return null;
	} catch {
		return null;
	}
}

export function saveConfig(config: TelebridgeConfig): void {
	fs.mkdirSync(CONFIG_DIR, { recursive: true });
	fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
}

export function resolveToken(): string | null {
	// 1. Environment variable takes priority
	const envToken = process.env.TELEGRAM_BOT_TOKEN;
	if (envToken) return envToken;

	// 2. Fall back to config file
	const config = loadConfig();
	return config?.botToken ?? null;
}

export function resolveChatId(): number | null {
	// 1. Environment variable takes priority
	const envChatId = process.env.TELEGRAM_CHAT_ID;
	if (envChatId) {
		const parsed = parseInt(envChatId, 10);
		if (!isNaN(parsed)) return parsed;
	}

	// 2. Fall back to config file
	const config = loadConfig();
	return config?.chatId ?? null;
}
