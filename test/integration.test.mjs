import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parse } from "acorn";

import { obfuscateSource, transpileTypeScript } from "../dist/index.js";
import { planFiles } from "../dist/files.js";

const PYTHON = process.env.PYTHON ?? "python3";
const MODES = ["structural", "lexical", "combined"];

async function temporaryDirectory(callback) {
  const directory = await mkdtemp(join(tmpdir(), "neutral-obfuscator-"));

  try {
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({ type: "module" }),
    );

    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function execute(command, args, cwd, timeout = 20_000) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout,
    maxBuffer: 4 * 1024 * 1024,
  });

  assert.ifError(result.error);

  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function assertNoMappingDirectives(code) {
  const comments = [];

  parse(code, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowHashBang: true,
    onComment: (_block, text) => comments.push(text),
  });

  assert.equal(
    comments.some((comment) =>
      /^\s*[@#]\s*source(?:Mapping)?URL\s*=/u.test(comment),
    ),
    false,
  );
}

for (const mode of MODES) {
  for (const fixture of ["sample.mjs", "sample.ts", "sample.py"]) {
    test(
      `${fixture}: ${mode} preserves fixture execution`,
      { timeout: 120_000 },
      async () => {
        await temporaryDirectory(async (directory) => {
          const source = await readFile(
            new URL(`./fixtures/${fixture}`, import.meta.url),
            "utf8",
          );

          const result = await obfuscateSource(source, fixture, {
            mode,
            seed: 1234,
            python: PYTHON,
          });

          const python = fixture.endsWith(".py");
          const typescript = fixture.endsWith(".ts");

          const baseline = typescript
            ? transpileTypeScript(source, fixture)
            : source;

          const extension = python ? ".py" : ".mjs";
          const originalPath = join(directory, `original${extension}`);
          const transformedPath = join(directory, `transformed${extension}`);

          await writeFile(originalPath, baseline);
          await writeFile(transformedPath, result.code);

          const command = python ? PYTHON : process.execPath;
          const flags = python ? ["-I", "-B", "-S"] : [];

          const original = execute(
            command,
            [...flags, originalPath],
            directory,
          );

          const transformed = execute(
            command,
            [...flags, transformedPath],
            directory,
          );

          assert.equal(original.status, 0, original.stderr);
          assert.equal(transformed.status, 0, transformed.stderr);
          assert.deepEqual(transformed, original);
          assert.notEqual(result.code, source);

          if (typescript) {
            assert.equal(result.outputExtension, ".js");
          }

          if (!python) {
            assertNoMappingDirectives(result.code);
          }

          if (python && mode !== "lexical") {
            assert.ok(result.stats.flattenedFunctions > 0);
            assert.ok(result.stats.encodedStrings > 0);
          }

          if (python && mode !== "structural") {
            assert.ok(result.stats.renamed > 0);
          }

          if (!python && mode !== "structural") {
            assert.match(result.code, /_n_/i);
          }
        });
      },
    );
  }

  test(`TypeScript module graph: ${mode}`, { timeout: 120_000 }, async () => {
    await temporaryDirectory(async (directory) => {
      const sources = {
        "dep.ts": `
            export function twice(value: number): number {
              const doubled = value + value;
              return doubled;
            }
          `,
        "main.ts": `
            import { twice } from "./dep.ts";
            console.log(twice(6));
          `,
      };

      const baselineDirectory = join(directory, "baseline");
      const outputDirectory = join(directory, "output");

      await mkdir(baselineDirectory);
      await mkdir(outputDirectory);

      for (const [filename, source] of Object.entries(sources)) {
        const outputName = filename.replace(/\.ts$/, ".js");

        await writeFile(
          join(baselineDirectory, outputName),
          transpileTypeScript(source, filename),
        );

        const result = await obfuscateSource(source, filename, {
          mode,
          seed: 81,
        });

        await writeFile(join(outputDirectory, outputName), result.code);
      }

      const baseline = execute(
        process.execPath,
        [join(baselineDirectory, "main.js")],
        baselineDirectory,
      );

      const transformed = execute(
        process.execPath,
        [join(outputDirectory, "main.js")],
        outputDirectory,
      );

      assert.equal(baseline.status, 0, baseline.stderr);
      assert.equal(transformed.status, 0, transformed.stderr);
      assert.deepEqual(transformed, baseline);
      assert.equal(transformed.stdout, "12\n");
    });
  });
}

test("known dynamic evaluation is rejected", async () => {
  await assert.rejects(
    obfuscateSource('console.log(eval("1 + 1"));', "dynamic.mjs", {
      mode: "combined",
      seed: 1,
    }),
    /dynamic construct/i,
  );

  await assert.rejects(
    obfuscateSource("print(globals())\n", "dynamic.py", {
      mode: "combined",
      seed: 1,
      python: PYTHON,
    }),
    /dynamic\/reflection/i,
  );
});

test(
  "fixed seeds produce reproducible output",
  { timeout: 120_000 },
  async () => {
    const source = `
      export function calculate(value) {
        const adjusted = value + 3;
        return adjusted * 2;
      }
    `;

    const options = { mode: "combined", seed: 9876 };

    const first = await obfuscateSource(source, "stable.mjs", options);

    const second = await obfuscateSource(source, "stable.mjs", options);

    assert.equal(first.code, second.code);
  },
);

test("output collisions and overwrites are rejected", async () => {
  await temporaryDirectory(async (directory) => {
    await writeFile(join(directory, "a.ts"), "const a: number = 1;");
    await writeFile(join(directory, "a.js"), "const a = 1;");

    const output = join(directory, "output");

    await assert.rejects(
      planFiles(["a.ts", "a.js"], directory, output),
      /collision/i,
    );

    await mkdir(output);
    await writeFile(join(output, "a.js"), "existing");

    await assert.rejects(planFiles(["a.ts"], directory, output), /overwrite/i);
  });
});

test(
  "CLI dry-run writes nothing and does not execute the input",
  { timeout: 120_000 },
  async () => {
    await temporaryDirectory(async (directory) => {
      const source = `
        import { writeFileSync } from "node:fs";
        writeFileSync("side-effect.txt", "must not execute");
      `;

      const inputPath = join(directory, "input.mjs");
      await writeFile(inputPath, source);

      const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

      const result = execute(
        process.execPath,
        [
          cli,
          "input.mjs",
          "--root",
          directory,
          "--out",
          "preview",
          "--mode",
          "combined",
          "--seed",
          "5",
          "--yes",
          "--dry-run",
        ],
        directory,
        110_000,
      );

      assert.equal(result.status, 0, result.stdout + result.stderr);

      await assert.rejects(access(join(directory, "preview")), {
        code: "ENOENT",
      });

      await assert.rejects(access(join(directory, "side-effect.txt")), {
        code: "ENOENT",
      });

      assert.equal(await readFile(inputPath, "utf8"), source);
    });
  },
);
