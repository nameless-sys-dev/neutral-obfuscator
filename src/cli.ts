#!/usr/bin/env node

import { realpath } from "node:fs/promises";
import { relative, resolve } from "node:path";

import { checkbox, confirm, input, select } from "@inquirer/prompts";
import { Command, Option } from "commander";
import ora from "ora";

import {
  discoverFiles,
  planFiles,
  prepareFiles,
  writePrepared,
} from "./files.js";
import { MODES, resolveSeed } from "./index.js";

import type { Mode } from "./types.js";

interface Flags {
  root: string;
  out?: string;
  mode?: Mode;
  seed?: string;
  python: string;
  yes: boolean;
  dryRun: boolean;
}

async function main(): Promise<void> {
  const program = new Command()
    .name("neutral-obfuscate")
    .description(
      "Conservative Python, JavaScript, and TypeScript source obfuscation.",
    )
    .argument("[files...]", "Explicit input paths, relative to --root")
    .option("--root <directory>", "Project root", ".")
    .option("-o, --out <directory>", "Output directory")
    .addOption(
      new Option("-m, --mode <mode>", "Transformation mode").choices([
        ...MODES,
      ]),
    )
    .option("--seed <number>", "Seed from 1 to 2147483646")
    .option(
      "--python <executable>",
      "Python 3.11+ executable",
      process.env.PYTHON ?? "python3",
    )
    .option("-y, --yes", "Disable prompts", false)
    .option("--dry-run", "Transform and preview without writing files", false);

  await program.parseAsync(process.argv);

  const flags = program.opts<Flags>();
  const interactive =
    !flags.yes && Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);

  if (!flags.yes && !interactive) {
    throw new Error(
      "Noninteractive use requires --yes and explicit input files.",
    );
  }

  const root = await realpath(resolve(flags.root));

  const mode: Mode =
    flags.mode ??
    (interactive
      ? await select<Mode>({
          message: "Choose an obfuscation mode:",
          choices: [
            {
              name: "Structural — AST, control-flow, and literal transforms",
              value: "structural",
            },
            {
              name: "Lexical — neutral randomized scoped identifiers",
              value: "lexical",
            },
            {
              name: "Combined — lexical followed by structural",
              value: "combined",
            },
          ],
        })
      : "combined");

  const outputAnswer =
    flags.out ??
    (interactive
      ? await input({
          message: "Output directory, relative to the project root:",
          default: "obfuscated",
          validate: (value) =>
            value.trim().length > 0 || "Enter an output directory.",
        })
      : "obfuscated");

  const output = resolve(root, outputAnswer);
  let filenames = [...program.args];

  if (filenames.length === 0) {
    if (!interactive) {
      throw new Error("Pass explicit input files when using --yes.");
    }

    const candidates = await discoverFiles(root, output);

    if (candidates.length === 0) {
      throw new Error("No supported source files were found.");
    }

    filenames = await checkbox<string>({
      message: "Select source files:",
      pageSize: 20,
      choices: candidates.map((filename) => ({
        name: filename,
        value: filename,
      })),
      validate: (choices) => choices.length > 0 || "Select at least one file.",
    });
  }

  const seed = resolveSeed(
    flags.seed === undefined ? undefined : Number(flags.seed),
  );

  const plan = await planFiles(filenames, root, output);

  console.log(`Mode: ${mode} | Seed: ${seed} | Dry run: ${flags.dryRun}`);

  console.table(
    plan.map((file) => ({
      input: file.relative,
      output: relative(root, file.output),
    })),
  );

  if (
    interactive &&
    !flags.dryRun &&
    !(await confirm({
      message: `Write ${plan.length} new file(s) under ${output}?`,
      default: false,
    }))
  ) {
    console.log("Cancelled.");
    return;
  }

  const terminalProgress = Boolean(process.stderr.isTTY);

  const spinner = ora({
    text: "Preparing transformations",
    stream: process.stderr,
    isEnabled: terminalProgress,
  }).start();

  let prepared;

  try {
    prepared = await prepareFiles(
      plan,
      { mode, seed, python: flags.python },
      (index, total, file) => {
        const message = `[${index + 1}/${total}] ${file.relative}`;

        if (terminalProgress) {
          spinner.text = message;
        } else {
          process.stderr.write(message + "\n");
        }
      },
    );

    if (!flags.dryRun) {
      spinner.text = "Writing validated outputs";
      await writePrepared(prepared);
    }

    spinner.succeed(
      flags.dryRun
        ? "Preview complete; no files were written."
        : `Wrote ${prepared.length} file(s).`,
    );
  } catch (error) {
    spinner.fail("Transformation failed; input files were not modified.");
    throw error;
  }

  console.table(
    prepared.map((file) => ({
      file: file.relative,
      inputBytes: file.inputBytes,
      outputBytes: Buffer.byteLength(file.result.code, "utf8"),
      passes: file.result.stats.passes.join(" → "),
    })),
  );

  for (const file of prepared) {
    for (const warning of file.result.warnings) {
      console.warn(`${file.relative}: ${warning}`);
    }

    if (flags.dryRun) {
      const preview = file.result.code.slice(0, 600);
      const suffix = file.result.code.length > 600 ? "\n[…truncated]" : "";

      console.log(
        `\n--- ${relative(root, file.output)} — not written ---\n` +
          preview +
          suffix,
      );
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
