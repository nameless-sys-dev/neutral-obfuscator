import { createHash } from "node:crypto";

import { parse } from "acorn";
import JavaScriptObfuscator from "javascript-obfuscator";
import ts from "typescript";

import type { EngineResult, JavaScriptJob } from "./types.js";

type BackendOptions = NonNullable<
  Parameters<typeof JavaScriptObfuscator.obfuscate>[1]
>;

const TS_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  isolatedModules: true,
  verbatimModuleSyntax: true,
  useDefineForClassFields: true,
  rewriteRelativeImportExtensions: true,
  sourceMap: false,
  inlineSourceMap: false,
  inlineSources: false,
  removeComments: false,
};

export function transpileTypeScript(
  source: string,
  filename = "input.ts",
): string {
  const result = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: { ...TS_OPTIONS },
    reportDiagnostics: true,
  });

  const errors = (result.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );

  if (errors.length > 0) {
    throw new Error(
      ts.formatDiagnostics(errors, {
        getCanonicalFileName: (name) => name,
        getCurrentDirectory: () => process.cwd(),
        getNewLine: () => "\n",
      }),
    );
  }

  return result.outputText;
}

function parseJavaScript(
  source: string,
  onComment?: (
    block: boolean,
    text: string,
    start: number,
    end: number,
  ) => void,
) {
  return parse(source, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowHashBang: true,
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
    onComment,
  });
}

/**
 * Remove only actual mapping/source URL comments.
 * A matching sequence inside a string or regular expression is preserved.
 */
function stripMappingComments(source: string): string {
  const ranges: Array<[number, number]> = [];

  parseJavaScript(source, (_block, text, start, end) => {
    if (/^\s*[@#]\s*source(?:Mapping)?URL\s*=/u.test(text)) {
      ranges.push([start, end]);
    }
  });

  let result = source;

  for (const [start, end] of ranges.reverse()) {
    const whitespace = result.slice(start, end).replace(/[^\r\n]/g, " ");

    result = result.slice(0, start) + whitespace + result.slice(end);
  }

  return result;
}

function walk(
  value: unknown,
  visitor: (node: Record<string, unknown>) => void,
): void {
  if (Array.isArray(value)) {
    for (const child of value) {
      walk(child, visitor);
    }
    return;
  }

  if (value === null || typeof value !== "object") {
    return;
  }

  const node = value as Record<string, unknown>;
  visitor(node);

  for (const child of Object.values(node)) {
    walk(child, visitor);
  }
}

function rejectObviousDynamicEvaluation(source: string): void {
  let unsupported: string | undefined;

  walk(parseJavaScript(source), (node) => {
    if (
      node.type === "Identifier" &&
      (node.name === "eval" || node.name === "Function")
    ) {
      unsupported = String(node.name);
    }

    if (node.type === "WithStatement") {
      unsupported = "with";
    }

    if (node.type === "MemberExpression" && node.computed) {
      const property = node.property as Record<string, unknown> | undefined;

      if (
        property?.type === "Literal" &&
        (property.value === "eval" || property.value === "Function")
      ) {
        unsupported = String(property.value);
      }
    }
  });

  if (unsupported) {
    throw new Error(
      `Unsupported dynamic construct: ${unsupported}. ` +
        "This transformer does not support runtime-generated code.",
    );
  }
}

function splitHashbang(source: string): [string, string] {
  if (!source.startsWith("#!")) {
    return ["", source];
  }

  const newline = source.indexOf("\n");

  return newline < 0
    ? [source + "\n", ""]
    : [source.slice(0, newline + 1), source.slice(newline + 1)];
}

function neutralDictionary(seed: number): string[] {
  return Array.from({ length: 2048 }, (_, index) => {
    const suffix = createHash("sha256")
      .update(`${seed}:${index}`)
      .digest("hex")
      .slice(0, 24);

    return `_n_${suffix}`;
  });
}

function baseOptions(seed: number): BackendOptions {
  return {
    target: "node",
    seed,
    compact: true,
    log: false,

    sourceMap: false,
    renameGlobals: false,
    renameProperties: false,
    transformObjectKeys: false,
    ignoreImports: true,

    debugProtection: false,
    debugProtectionInterval: 0,
    selfDefending: false,
    disableConsoleOutput: false,

    controlFlowFlattening: false,
    deadCodeInjection: false,
    numbersToExpressions: false,
    simplify: false,

    stringArray: false,
    stringArrayCallsTransform: false,
    stringArrayRotate: false,
    stringArrayShuffle: false,
    splitStrings: false,
    unicodeEscapeSequence: false,

    identifierNamesGenerator: "hexadecimal",
  };
}

export function transformJavaScript(job: JavaScriptJob): EngineResult {
  const [hashbang, body] = splitHashbang(job.source);

  let code =
    job.language === "typescript"
      ? transpileTypeScript(body, job.filename)
      : body;

  code = stripMappingComments(code);
  rejectObviousDynamicEvaluation(code);

  const passes: string[] = [];

  if (job.mode === "lexical" || job.mode === "combined") {
    code = JavaScriptObfuscator.obfuscate(code, {
      ...baseOptions(job.seed),
      identifierNamesGenerator: "dictionary",
      identifiersDictionary: neutralDictionary(job.seed),
    }).getObfuscatedCode();

    passes.push("lexical");
  }

  if (job.mode === "structural" || job.mode === "combined") {
    const structuralSeed = job.seed === 2_147_483_646 ? 1 : job.seed + 1;

    code = JavaScriptObfuscator.obfuscate(code, {
      ...baseOptions(structuralSeed),

      controlFlowFlattening: true,
      controlFlowFlatteningThreshold: 1,

      deadCodeInjection: true,
      deadCodeInjectionThreshold: 0.2,

      numbersToExpressions: true,
      simplify: true,

      stringArray: true,
      stringArrayThreshold: 1,
      stringArrayEncoding: ["rc4"],
      stringArrayCallsTransform: true,
      stringArrayCallsTransformThreshold: 1,
      stringArrayRotate: true,
      stringArrayShuffle: true,

      splitStrings: true,
      splitStringsChunkLength: 8,

      // Dictionary identifiers may use case variants.
      reservedNames: job.mode === "combined" ? ["^_[nN]_"] : [],
    }).getObfuscatedCode();

    passes.push("structural");
  }

  // Also validates the final JavaScript syntax.
  code = stripMappingComments(code);

  return {
    code: hashbang + code.trimEnd() + "\n",
    stats: { passes },
    warnings:
      job.language === "typescript"
        ? [
            "TypeScript was emitted as ES2022/ESNext JavaScript; " +
              "type checking and project-specific tsconfig settings are not applied.",
          ]
        : [],
  };
}
