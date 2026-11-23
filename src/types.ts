export const MODES = ["structural", "lexical", "combined"] as const;

export type Mode = (typeof MODES)[number];

export type Language = "javascript" | "typescript" | "python";

export interface ObfuscateOptions {
  mode: Mode;
  seed?: number;
  python?: string;
}

export interface TransformStats {
  passes: string[];
  renamed?: number;
  encodedStrings?: number;
  flattenedFunctions?: number;
  skippedScopes?: number;
}

export interface EngineResult {
  code: string;
  stats: TransformStats;
  warnings: string[];
}

export interface ObfuscationResult extends EngineResult {
  language: Language;
  outputExtension: string;
}

export interface JavaScriptJob {
  source: string;
  filename: string;
  language: "javascript" | "typescript";
  mode: Mode;
  seed: number;
}
