import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  stat,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";

import fg from "fast-glob";

import {
  MAX_SOURCE_BYTES,
  obfuscateSource,
  outputFileName,
  resolveSeed,
} from "./index.js";

import type { ObfuscateOptions, ObfuscationResult } from "./types.js";

export interface PlannedFile {
  input: string;
  output: string;
  relative: string;
  permissions: number;
}

export interface PreparedFile extends PlannedFile {
  inputBytes: number;
  result: ObfuscationResult;
}

function within(parent: string, child: string): boolean {
  const path = relative(parent, child);

  return (
    path === "" ||
    (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`))
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function discoverFiles(
  root: string,
  output: string,
): Promise<string[]> {
  const ignore = [
    "**/node_modules/**",
    "**/.git/**",
    "**/.venv/**",
    "**/venv/**",
    "**/__pycache__/**",
    "**/*.d.ts",
  ];

  if (within(root, output) && root !== output) {
    const outputPattern = relative(root, output).split(sep).join("/");

    ignore.push(`${fg.escapePath(outputPattern)}/**`);
  }

  const files = await fg(
    ["**/*.js", "**/*.mjs", "**/*.cjs", "**/*.ts", "**/*.py"],
    {
      cwd: root,
      onlyFiles: true,
      followSymbolicLinks: false,
      dot: false,
      ignore,
    },
  );

  return files.filter((file) => !within(output, resolve(root, file))).sort();
}

export async function planFiles(
  filenames: string[],
  rootDirectory: string,
  outputDirectory: string,
): Promise<PlannedFile[]> {
  const root = await realpath(resolve(rootDirectory));
  const outputRoot = resolve(root, outputDirectory);

  if (within(outputRoot, root)) {
    throw new Error(
      "The output directory must not equal or contain the project root.",
    );
  }

  if (filenames.length === 0) {
    throw new Error("No input files were selected.");
  }

  const inputPaths = new Set<string>();
  const outputPaths = new Set<string>();
  const plan: PlannedFile[] = [];

  for (const filename of filenames) {
    const input = await realpath(resolve(root, filename));

    if (!within(root, input) || within(outputRoot, input)) {
      throw new Error(
        `Input must be inside the project root and outside the output: ${filename}`,
      );
    }

    if (inputPaths.has(input)) {
      continue;
    }
    inputPaths.add(input);

    const information = await stat(input);

    if (!information.isFile()) {
      throw new Error(`Not a regular file: ${filename}`);
    }

    if (information.size > MAX_SOURCE_BYTES) {
      throw new Error(`Input exceeds 4 MiB: ${filename}`);
    }

    const relativeName = relative(root, input);
    const output = resolve(outputRoot, outputFileName(relativeName));

    // Conservatively avoid case-only collisions across platforms.
    const collisionKey = output.toLowerCase();

    if (outputPaths.has(collisionKey)) {
      throw new Error(`Output collision: ${output}`);
    }
    outputPaths.add(collisionKey);

    if (await exists(output)) {
      throw new Error(`Refusing to overwrite existing output: ${output}`);
    }

    plan.push({
      input,
      output,
      relative: relativeName,
      permissions: information.mode & 0o777,
    });
  }

  return plan;
}

function fileSeed(seed: number, filename: string): number {
  const normalized = filename.split(sep).join("/");
  const digest = createHash("sha256").update(`${seed}\0${normalized}`).digest();

  return (digest.readUInt32BE(0) % 2_147_483_646) + 1;
}

export async function prepareFiles(
  plan: PlannedFile[],
  options: ObfuscateOptions,
  progress?: (index: number, total: number, file: PlannedFile) => void,
): Promise<PreparedFile[]> {
  const seed = resolveSeed(options.seed);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const prepared: PreparedFile[] = [];

  for (let index = 0; index < plan.length; index += 1) {
    const file = plan[index];
    progress?.(index, plan.length, file);

    const bytes = await readFile(file.input);
    const source = decoder.decode(bytes);

    const result = await obfuscateSource(source, file.input, {
      ...options,
      seed: fileSeed(seed, file.relative),
    });

    prepared.push({
      ...file,
      inputBytes: bytes.byteLength,
      result,
    });
  }

  return prepared;
}

/**
 * Called only after every input has transformed and validated.
 * Existing files are never replaced.
 */
export async function writePrepared(files: PreparedFile[]): Promise<void> {
  const created: string[] = [];

  try {
    for (const file of files) {
      await mkdir(dirname(file.output), { recursive: true });

      const handle = await open(file.output, "wx", file.permissions);

      created.push(file.output);

      try {
        await handle.writeFile(file.result.code, "utf8");
      } finally {
        await handle.close();
      }
    }
  } catch (error) {
    // Best-effort cleanup of files created by this batch.
    // Newly created empty directories may remain.
    await Promise.allSettled(created.map((filename) => unlink(filename)));

    throw error;
  }
}
