/**
 * Converts markdown text to Telegram-compatible HTML.
 *
 * Handles:
 * - Fenced code blocks → <pre><code>...</code></pre>
 * - Inline code → <code>...</code>
 * - Bold **text** → <b>text</b>
 * - Italic *text* → <i>text</i>
 * - Strikethrough ~~text~~ → <s>text</s>
 * - Links [text](url) → <a href="url">text</a>
 * - HTML entity escaping inside code
 *
 * Telegram limit: 4096 characters per message.
 */

const TELEGRAM_MAX_LENGTH = 4096;
const TRUNCATION_NOTICE = "\n\n<i>[truncated — see pi terminal]</i>";

function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function markdownToTelegramHtml(md: string): string {
	let html = "";
	const lines = md.split("\n");
	let inCodeBlock = false;
	let codeLang = "";
	let codeContent = "";

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		// Fenced code block start/end
		if (line.trimStart().startsWith("```")) {
			if (!inCodeBlock) {
				inCodeBlock = true;
				codeLang = line.trimStart().slice(3).trim();
				codeContent = "";
			} else {
				// Close code block
				inCodeBlock = false;
				if (codeLang) {
					html += `<pre><code class="language-${escapeHtml(codeLang)}">`;
				} else {
					html += "<pre><code>";
				}
				html += escapeHtml(codeContent);
				html += "</code></pre>\n";
				codeLang = "";
			}
			continue;
		}

		if (inCodeBlock) {
			if (codeContent) codeContent += "\n";
			codeContent += line;
			continue;
		}

		// Normal line — convert inline markdown
		html += convertInlineMarkdown(line) + "\n";
	}

	// If code block was never closed, dump it anyway
	if (inCodeBlock) {
		html += "<pre><code>";
		html += escapeHtml(codeContent);
		html += "</code></pre>\n";
	}

	return html.trimEnd();
}

function convertInlineMarkdown(line: string): string {
	// Escape HTML first in non-code parts
	// We need to be careful: process inline code first, then escape the rest

	// Extract inline code spans to protect them
	const codeSpans: string[] = [];
	let processed = line.replace(/`([^`]+)`/g, (_match, code) => {
		const idx = codeSpans.length;
		codeSpans.push(`<code>${escapeHtml(code)}</code>`);
		return `\x00CODE${idx}\x00`;
	});

	// Now escape HTML in the remaining text
	processed = escapeHtml(processed);

	// Bold **text** or __text__
	processed = processed.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
	processed = processed.replace(/__(.+?)__/g, "<b>$1</b>");

	// Italic *text* or _text_ (but not inside words for underscore)
	processed = processed.replace(/\*(.+?)\*/g, "<i>$1</i>");

	// Strikethrough ~~text~~
	processed = processed.replace(/~~(.+?)~~/g, "<s>$1</s>");

	// Links [text](url)
	processed = processed.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

	// Restore inline code spans
	processed = processed.replace(/\x00CODE(\d+)\x00/g, (_match, idx) => {
		return codeSpans[parseInt(idx, 10)];
	});

	return processed;
}

/**
 * Split a message into chunks that fit Telegram's 4096 char limit.
 * Tries to split at newlines when possible.
 */
export function splitForTelegram(html: string): string[] {
	if (html.length <= TELEGRAM_MAX_LENGTH) {
		return [html];
	}

	const chunks: string[] = [];
	let remaining = html;

	while (remaining.length > 0) {
		if (remaining.length <= TELEGRAM_MAX_LENGTH) {
			chunks.push(remaining);
			break;
		}

		// Reserve space for truncation notice on the first chunk if needed
		const maxChunk = TELEGRAM_MAX_LENGTH - TRUNCATION_NOTICE.length;

		// Try to find a newline to split at
		let splitAt = remaining.lastIndexOf("\n", maxChunk);
		if (splitAt <= 0) {
			// No good newline, just split at max
			splitAt = maxChunk;
		}

		const chunk = remaining.slice(0, splitAt);
		chunks.push(chunk);
		remaining = remaining.slice(splitAt).trimStart();
	}

	// Add truncation notice to last chunk if we split
	if (chunks.length > 1) {
		const last = chunks[chunks.length - 1];
		if (last.length + TRUNCATION_NOTICE.length > TELEGRAM_MAX_LENGTH) {
			// Trim last chunk to fit the notice
			chunks[chunks.length - 1] = last.slice(0, TELEGRAM_MAX_LENGTH - TRUNCATION_NOTICE.length) + TRUNCATION_NOTICE;
		} else {
			chunks[chunks.length - 1] = last + TRUNCATION_NOTICE;
		}
	}

	return chunks;
}
