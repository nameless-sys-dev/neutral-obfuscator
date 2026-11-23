import { randomInt } from "node:crypto";
import { extname } from "node:path";

import { runJavaScriptWorker } from "./javascript-client.js";
import { runPythonWorker } from "./python.js";
import { MODES } from "./types.js";

import type { Language, ObfuscateOptions, ObfuscationResult } from "./types.js";

export { MODES };
export { transpileTypeScript } from "./javascript.js";

export type {
  Language,
  Mode,
  ObfuscateOptions,
  ObfuscationResult,
  TransformStats,
} from "./types.js";

export const MAX_SOURCE_BYTES = 4 * 1024 * 1024;

export function resolveSeed(seed?: number): number {
  if (seed === undefined) {
    return randomInt(1, 2_147_483_647);
  }

  if (!Number.isSafeInteger(seed) || seed < 1 || seed > 2_147_483_646) {
    throw new Error("Seed must be an integer from 1 to 2147483646.");
  }

  return seed;
}

export function languageOf(filename: string): Language {
  if (/\.d\.ts$/i.test(filename)) {
    throw new Error("Declaration files are not executable inputs.");
  }

  switch (extname(filename).toLowerCase()) {
    case ".js":
    case ".mjs":
    case ".cjs":
      return "javascript";
    case ".ts":
      return "typescript";
    case ".py":
      return "python";
    default:
      throw new Error(`Unsupported input extension: ${filename}`);
  }
}

export function outputFileName(filename: string): string {
  return languageOf(filename) === "typescript"
    ? filename.slice(0, -3) + ".js"
    : filename;
}

export async function obfuscateSource(
  source: string,
  filename: string,
  options: ObfuscateOptions = { mode: "combined" },
): Promise<ObfuscationResult> {
  if (!MODES.includes(options.mode)) {
    throw new Error(`Unsupported mode: ${String(options.mode)}`);
  }

  if (Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES) {
    throw new Error("Input exceeds the 4 MiB source-size limit.");
  }

  const language = languageOf(filename);
  const seed = resolveSeed(options.seed);

  const result =
    language === "python"
      ? await runPythonWorker(
          source,
          filename,
          options.mode,
          seed,
          options.python ?? process.env.PYTHON ?? "python3",
        )
      : await runJavaScriptWorker({
          source,
          filename,
          language,
          mode: options.mode,
          seed,
        });

  return {
    ...result,
    language,
    outputExtension: extname(outputFileName(filename)),
  };
}
