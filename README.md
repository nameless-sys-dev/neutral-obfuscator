# neutral-obfuscator

An interactive npm-style CLI and TypeScript API for conventional source
obfuscation using neutral randomized identifiers.

## Requirements

- Node.js 20+
- Python 3.11+ when processing Python
- UTF-8 input files

Supported extensions:

- JavaScript: `.js`, `.mjs`, `.cjs`
- TypeScript: `.ts`
- Python: `.py`

Declaration files, TSX, and unsupported parser/backend syntax are rejected.

## Install and build

    npm install
    npm run build
    npm test
    npm link

Python can be selected with `--python` or the `PYTHON` environment variable.

## Interactive usage

    neutral-obfuscate --root ../project

The CLI prompts for:

1. Transformation mode
2. Output directory
3. Input files
4. Confirmation before writing

## Noninteractive usage

    neutral-obfuscate src/app.ts src/helpers.ts \
      --root . \
      --out protected \
      --mode combined \
      --seed 123 \
      --yes

Explicit input paths are relative to `--root`.

Without an explicit mode or output directory, unattended mode defaults to
`combined` and `obfuscated`.

## Dry run

    neutral-obfuscate src/app.ts \
      --mode combined \
      --out protected \
      --yes \
      --dry-run

Dry runs perform transformation and syntax validation, show byte counts
and truncated previews, and do not create the output directory or files.

Selected programs are not launched by the CLI.

## API

    import {
      obfuscateSource
    } from "neutral-obfuscator";

    const result = await obfuscateSource(
      `
        export function twice(value: number): number {
          const doubled = value + value;
          return doubled;
        }
      `,
      "module.ts",
      {
        mode: "combined",
        seed: 123
      }
    );

    console.log(result.outputExtension); // .js
    console.log(result.code);
    console.log(result.stats);
    console.log(result.warnings);

## Modes

### Structural

JavaScript and TypeScript use javascript-obfuscator for AST-based
control-flow flattening, dead-code injection, numeric expressions,
string splitting, and encoded string arrays.

Python uses:

- AST parsing and emission
- Dispatcher flattening for eligible synchronous straight-line functions
- An integer opaque predicate and unreachable arithmetic branch
- Reversible XOR-based string literal encoding

Python dispatcher transformations are limited to functions with 2–64
eligible statements. String encoding is limited to literals of 1–2048
characters.

These are bounded structural transformations, not a general-purpose VM.

### Lexical

JavaScript uses neutral randomized dictionary identifiers for scoped
bindings. Global names and property names are preserved.

Python renames simple function-local bindings. Parameter names,
function/class names, imports, globals, nonlocals, and complicated binding
scopes are preserved.

Python scopes containing closures, comprehensions, pattern bindings,
exception bindings, or other unsupported binding constructs are skipped
by the local-renaming pass.

No identifiers are selected to manipulate safety filters or model
tokenization.

### Combined

Runs lexical transformation followed by structural transformation.

JavaScript preserves the neutral dictionary identifiers during the second
pass. Python shares a collision-avoiding name allocator across passes.

## TypeScript behavior

TypeScript is emitted as JavaScript, not as a reconstructed typed source
file.

The compilation baseline is:

- Target: ES2022
- Modules: ESNext
- Module resolution: Bundler
- Isolated modules
- Verbatim module syntax
- Define-style class fields
- Relative `.ts` import extension rewriting
- No source maps

The tool does not type-check projects or load project-specific tsconfig
settings. Use an appropriate project build first if those settings affect
your runtime semantics.

## Output handling

- Selected directory structure is mirrored under the output directory.
- `.ts` becomes `.js`.
- Other supported extensions are retained.
- Output collisions and existing destination files are rejected.
- Every transformation completes and validates before writing starts.
- New files are opened exclusively; existing files are never replaced.
- A write failure triggers best-effort cleanup of newly created files.
- New empty directories may remain after an I/O failure.
- Hashbangs and executable permission bits are retained.
- Inputs are limited to 4 MiB each.

The tool is not a bundler. It does not copy package.json, assets, native
extensions, dependencies, or unselected modules. Preserve module context
and make runtime imports and assets available in the output deployment.

JavaScript using ESM `.js` files needs an appropriate package.json
`type` setting or equivalent runtime configuration.

## Source maps and name maps

No source maps or identifier-map sidecars are produced.

Actual JavaScript sourceMappingURL/sourceURL comments are removed using
parser-provided comment ranges. Matching text inside runtime strings is
not removed.

Python comments are removed by AST emission, apart from the hashbang.

## Behavioral contract and limitations

This is not a proof of semantic equivalence.

The supported contract excludes dependencies on:

- eval, exec, Function, or runtime-generated source
- Source text, bytecode, stack-frame, or local-variable inspection
- Function names changed by JavaScript scoped renaming
- Debugger, tracing, profiling, or audit-hook behavior
- Exact stack traces, line numbers, or local-name-dependent error messages
- Timing, memory usage, allocation counts, or Python literal identity
- Monkey-patched builtins
- Original source file paths after relocation

Some obvious dynamic/reflection constructs are rejected. These checks are
conservative and incomplete; they are not a sandbox or a security scanner.

Python docstrings, annotations, pattern literals, and literal f-string
segments are preserved. These preserved regions may reveal information.

The test suite compares execution results for bundled fixtures across
all nine language/mode combinations and tests module imports, dry runs,
source-map suppression, reproducibility, and overwrite protection.

Run application-specific equivalence tests before shipping transformed
code.

## Security expectations

Obfuscation increases inspection effort; it does not make reverse
engineering computationally infeasible.

Literal decoders and keys ship with the program. The JavaScript backend's
RC4 option and the Python XOR encoding are obfuscation mechanisms, not
cryptographic confidentiality.

Randomized names and seeds are not cryptographic secrets.

Keep actual secrets and irreplaceable proprietary logic outside
distributed client-side source where possible.

## Architecture

- `src/cli.ts`: prompts, progress, previews
- `src/files.ts`: discovery, planning, safe output handling
- `src/index.ts`: public API and validation
- `src/javascript.ts`: JavaScript/TypeScript AST backend
- `src/javascript-client.ts`: bounded worker lifecycle
- `src/javascript-worker.ts`: CPU-isolated transformation entry point
- `src/python.ts`: isolated Python worker bridge
- `python/worker.py`: Python AST transformations
- `test/`: execution-equivalence and operational regression tests

The bundled test suite executes its fixtures locally. Do not extend it to
execute untrusted programs without a separate isolation environment.
