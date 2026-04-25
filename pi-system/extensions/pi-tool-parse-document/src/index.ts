import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import * as os from "node:os";
import mammoth from "mammoth";
import * as XLSX from "xlsx";
import pptxParser from "pptx-text-parser";

const execFileAsync = promisify(execFile);

const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tiff", ".tif"];
const TEXT_EXTS = [".txt", ".md", ".json", ".js", ".ts", ".html", ".css", ".xml", ".log"];

interface DocToolsConfig {
  maxChars: number;
  maxPdfOcrPages: number;
}

const DEFAULT_CONFIG: DocToolsConfig = {
  maxChars: 150_000,
  maxPdfOcrPages: 10,
};

function getConfigPath(): string {
  return path.join(os.homedir(), "pi-system", "extensions", "pi-tool-parse-document", "config.json");
}

async function loadConfig(): Promise<DocToolsConfig> {
  const configPath = getConfigPath();
  try {
    const data = await fs.readFile(configPath, "utf-8");
    const parsed = JSON.parse(data);
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    try {
      await fs.writeFile(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2));
    } catch {
      // If we can't write defaults, just use them in memory
    }
    return DEFAULT_CONFIG;
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "parse_document",
    label: "Parse Document",
    description:
      "Extract text/content from local documents (PDF, images via OCR, DOCX, XLSX, PPTX, CSV, TXT). Requires poppler (pdftotext/pdftoppm/pdfinfo) and tesseract.",
    parameters: Type.Object({
      path: Type.String({ description: "Absolute or relative path to the document" }),
      ocr: Type.Optional(Type.Boolean({ description: "Force OCR for images or scanned PDFs" })),
      ocrLanguage: Type.Optional(
        Type.String({ description: "Tesseract OCR language (default: eng)", default: "eng" })
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const config = await loadConfig();
      const filePath = path.resolve(ctx.cwd, params.path);
      const ext = path.extname(filePath).toLowerCase();

      if (!(await fileExists(filePath))) {
        return {
          content: [{ type: "text", text: `File not found: ${filePath}` }],
          isError: true,
          details: {},
        };
      }

      let resultText = "";
      let warning: string | undefined;

      try {
        if (ext === ".pdf") {
          const res = await parsePdf(filePath, params.ocr, params.ocrLanguage, signal, config.maxPdfOcrPages);
          resultText = res.text;
          warning = res.warning;
        } else if (IMAGE_EXTS.includes(ext)) {
          if (!params.ocr) {
            return {
              content: [
                { type: "text", text: `Image detected (${ext}). Set ocr:true to extract text via OCR.` },
              ],
              details: {},
            };
          }
          resultText = await parseImageOcr(filePath, params.ocrLanguage, signal);
        } else if (ext === ".docx") {
          resultText = await parseDocx(filePath);
        } else if (ext === ".xlsx" || ext === ".xls") {
          resultText = await parseXlsx(filePath);
        } else if (ext === ".pptx") {
          resultText = await parsePptx(filePath);
        } else if (ext === ".csv") {
          resultText = await fs.readFile(filePath, "utf-8");
        } else if (TEXT_EXTS.includes(ext)) {
          resultText = await fs.readFile(filePath, "utf-8");
        } else {
          return {
            content: [{ type: "text", text: `Unsupported extension: ${ext}` }],
            isError: true,
            details: {},
          };
        }
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Parse error: ${err.message || String(err)}` }],
          isError: true,
          details: { error: err.message || String(err) },
        };
      }

      const originalLength = resultText.length;
      let truncated = false;
      if (originalLength > config.maxChars) {
        resultText =
          resultText.slice(0, config.maxChars) +
          `\n\n[AVISO: Documento truncado. Total original: ${originalLength.toLocaleString()} caracteres. Mostrando: ${config.maxChars.toLocaleString()}]`;
        truncated = true;
      }

      if (warning) {
        resultText = `[${warning}]\n\n` + resultText;
      }

      return {
        content: [{ type: "text", text: resultText || "(empty content)" }],
        details: {
          path: filePath,
          extension: ext,
          length: originalLength,
          truncated,
          warning,
        },
      };
    },
  });
}

async function parsePdf(
  filePath: string,
  forceOcr?: boolean,
  ocrLang?: string,
  signal?: AbortSignal,
  maxPdfOcrPages: number = 10
): Promise<{ text: string; warning?: string }> {
  if (!forceOcr) {
    try {
      const { stdout } = await execFileAsync("pdftotext", [filePath, "-"], {
        timeout: 60000,
        signal: signal as any,
      });
      if (stdout.trim().length > 50) return { text: stdout };
    } catch {
      // Fall through to OCR fallback
    }
  }

  // Verify pdftoppm exists for OCR fallback
  try {
    await execFileAsync("which", ["pdftoppm"], { timeout: 5000 });
  } catch {
    throw new Error("pdftotext yielded no text and OCR fallback requires poppler (pdftoppm).");
  }

  // Try to get total page count
  let totalPages = 0;
  try {
    const { stdout } = await execFileAsync("pdfinfo", [filePath], {
      timeout: 10000,
      signal: signal as any,
    });
    const match = stdout.match(/Pages:\s+(\d+)/);
    if (match) totalPages = parseInt(match[1], 10);
  } catch {
    // ignore; proceed without knowing total
  }

  const pagesToProcess = totalPages > 0 ? Math.min(totalPages, maxPdfOcrPages) : maxPdfOcrPages;

  const tmpBase = path.join(os.homedir(), "workspace", "tmp");
  await fs.mkdir(tmpBase, { recursive: true });
  const tmpDir = path.join(tmpBase, `pi-parse-${Date.now()}`);
  await fs.mkdir(tmpDir, { recursive: true });

  let warning: string | undefined;

  try {
    await execFileAsync(
      "pdftoppm",
      ["-png", "-f", "1", "-l", String(pagesToProcess), filePath, path.join(tmpDir, "page")],
      { timeout: 120000, signal: signal as any }
    );

    const files = (await fs.readdir(tmpDir))
      .filter((f) => f.endsWith(".png"))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    const texts: string[] = [];
    for (const f of files) {
      const imgPath = path.join(tmpDir, f);
      try {
        const txt = await parseImageOcr(imgPath, ocrLang, signal);
        if (txt.trim()) texts.push(txt);
      } catch {
        // ignore single page failures
      }
    }

    if (totalPages > pagesToProcess) {
      warning = `AVISO: El PDF tiene ${totalPages} páginas. Se procesaron ${pagesToProcess} vía OCR.`;
    } else if (totalPages === 0) {
      warning = `AVISO: Se procesaron hasta ${pagesToProcess} páginas vía OCR (no se pudo determinar el total).`;
    }

    return { text: texts.join("\n\n--- Page Break ---\n\n"), warning };
  } finally {
    try {
      const files = await fs.readdir(tmpDir);
      for (const f of files) await fs.unlink(path.join(tmpDir, f));
      await fs.rmdir(tmpDir);
    } catch {
      // ignore cleanup errors
    }
  }
}

async function parseImageOcr(filePath: string, lang = "eng", signal?: AbortSignal): Promise<string> {
  const { stdout } = await execFileAsync("tesseract", [filePath, "stdout", "-l", lang], {
    timeout: 60000,
    signal: signal as any,
  });
  return stdout;
}

async function parseDocx(filePath: string): Promise<string> {
  const buf = await fs.readFile(filePath);
  const result = await mammoth.extractRawText({ buffer: buf });
  return result.value;
}

async function parseXlsx(filePath: string): Promise<string> {
  const buf = await fs.readFile(filePath);
  const workbook = XLSX.read(buf, { type: "buffer" });
  let out = "";
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const json = XLSX.utils.sheet_to_json(sheet, { header: 1 }) as any[][];
    out += `Sheet: ${sheetName}\n`;
    for (const row of json) {
      out += (row || []).join("\t") + "\n";
    }
    out += "\n";
  }
  return out;
}

async function parsePptx(filePath: string): Promise<string> {
  const text = await pptxParser(filePath, "text");
  return typeof text === "string" ? text : JSON.stringify(text, null, 2);
}
