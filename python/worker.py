import ast
import json
import random
import re
import sys


SCOPES = (
    ast.FunctionDef,
    ast.AsyncFunctionDef,
    ast.ClassDef,
    ast.Lambda,
    ast.ListComp,
    ast.SetComp,
    ast.DictComp,
    ast.GeneratorExp,
)

OPTIONAL_SCOPES = (
    (ast.TypeAlias,) if hasattr(ast, "TypeAlias") else ()
)

RENAME_BLOCKERS = SCOPES + OPTIONAL_SCOPES + (
    ast.Global,
    ast.Nonlocal,
    ast.Import,
    ast.ImportFrom,
    ast.ExceptHandler,
    ast.Match,
)

DYNAMIC_NAMES = {
    "eval",
    "exec",
    "compile",
    "locals",
    "globals",
    "vars",
    "dir",
    "__import__",
    "__builtins__",
}

REFLECTIVE_ATTRIBUTES = DYNAMIC_NAMES | {
    "__code__",
    "__globals__",
    "__closure__",
    "_getframe",
    "currentframe",
    "settrace",
    "setprofile",
    "f_locals",
    "f_globals",
    "co_varnames",
}


def body_nodes(function):
    return [
        node
        for statement in function.body
        for node in ast.walk(statement)
    ]


def is_docstring(statement):
    return (
        isinstance(statement, ast.Expr)
        and isinstance(statement.value, ast.Constant)
        and isinstance(statement.value.value, str)
    )


def reject_obvious_reflection(tree):
    template_type = getattr(ast, "TemplateStr", None)

    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and node.id in DYNAMIC_NAMES:
            raise ValueError(
                f"Unsupported dynamic/reflection construct: {node.id}"
            )

        if (
            isinstance(node, ast.Attribute)
            and node.attr in REFLECTIVE_ATTRIBUTES
        ):
            raise ValueError(
                f"Unsupported reflective attribute: {node.attr}"
            )

        if isinstance(node, ast.Import):
            if any(
                alias.name.split(".")[0] == "inspect"
                for alias in node.names
            ):
                raise ValueError("The inspect module is unsupported.")

        if isinstance(node, ast.ImportFrom):
            module = node.module or ""

            if module.split(".")[0] == "inspect":
                raise ValueError("The inspect module is unsupported.")

            if module == "builtins" and any(
                alias.name in DYNAMIC_NAMES for alias in node.names
            ):
                raise ValueError(
                    "Importing dynamic-evaluation builtins is unsupported."
                )

        if template_type is not None and isinstance(node, template_type):
            raise ValueError("Template strings are not supported yet.")


class Names:
    def __init__(self, source, rng):
        self.rng = rng
        self.taken = set(
            re.findall(r"\b[A-Za-z_][A-Za-z_0-9]*\b", source)
        )

    def new(self):
        while True:
            candidate = f"_n_{self.rng.getrandbits(96):024x}"

            if candidate not in self.taken:
                self.taken.add(candidate)
                return candidate


class RewriteNames(ast.NodeTransformer):
    def __init__(self, mapping):
        self.mapping = mapping

    def visit_Name(self, node):
        node.id = self.mapping.get(node.id, node.id)
        return node

    def visit_AnnAssign(self, node):
        node.target = self.visit(node.target)

        if node.value is not None:
            node.value = self.visit(node.value)

        # Preserve annotation spelling.
        return node


class LocalRenamer(ast.NodeTransformer):
    """
    Rename simple function-local bindings only.

    Parameters, function/class names, imports, globals, nonlocals,
    and scopes with nested binding rules are preserved.
    """

    def __init__(self, names):
        self.names = names
        self.count = 0
        self.skipped = 0

    def visit_FunctionDef(self, node):
        # Independently process eligible nested leaf functions.
        self.generic_visit(node)

        nodes = body_nodes(node)

        if any(isinstance(item, RENAME_BLOCKERS) for item in nodes):
            self.skipped += 1
            return node

        arguments = {
            argument.arg
            for argument in (
                *node.args.posonlyargs,
                *node.args.args,
                *node.args.kwonlyargs,
            )
        }

        if node.args.vararg is not None:
            arguments.add(node.args.vararg.arg)

        if node.args.kwarg is not None:
            arguments.add(node.args.kwarg.arg)

        candidates = {
            item.id
            for item in nodes
            if isinstance(item, ast.Name)
            and isinstance(item.ctx, (ast.Store, ast.Del))
            and item.id not in arguments
            and not (
                item.id.startswith("__") and item.id.endswith("__")
            )
        }

        mapping = {
            name: self.names.new() for name in sorted(candidates)
        }

        rewriter = RewriteNames(mapping)
        node.body = [rewriter.visit(item) for item in node.body]
        self.count += len(mapping)

        return node

    visit_AsyncFunctionDef = visit_FunctionDef


class Dispatcher(ast.NodeTransformer):
    """
    Flatten bounded, straight-line synchronous functions.

    Python block statements do not introduce lexical scopes, so eligible
    statements can be placed in a dispatcher without changing bindings.
    """

    SIMPLE_STATEMENTS = (
        ast.Assign,
        ast.AnnAssign,
        ast.AugAssign,
        ast.Expr,
        ast.Return,
        ast.Raise,
        ast.Pass,
    )

    def __init__(self, names, rng):
        self.names = names
        self.rng = rng
        self.count = 0

    def visit_FunctionDef(self, node):
        self.generic_visit(node)

        prefix = []
        statements = node.body

        if statements and is_docstring(statements[0]):
            prefix = [statements[0]]
            statements = statements[1:]

        if not 2 <= len(statements) <= 64:
            return node

        if not all(
            isinstance(statement, self.SIMPLE_STATEMENTS)
            for statement in statements
        ):
            return node

        blockers = SCOPES + OPTIONAL_SCOPES + (
            ast.Await,
            ast.Yield,
            ast.YieldFrom,
        )

        if any(
            isinstance(item, blockers)
            for statement in statements
            for item in ast.walk(statement)
        ):
            return node

        state = self.names.new()
        labels = self.rng.sample(
            range(1 << 20, 1 << 30),
            len(statements) + 1,
        )

        blocks = []

        for index, statement in enumerate(statements):
            next_state = ast.Assign(
                targets=[ast.Name(id=state, ctx=ast.Store())],
                value=ast.Constant(value=labels[index + 1]),
                type_comment=None,
            )

            blocks.append(
                ast.If(
                    test=ast.Compare(
                        left=ast.Name(id=state, ctx=ast.Load()),
                        ops=[ast.Eq()],
                        comparators=[
                            ast.Constant(value=labels[index])
                        ],
                    ),
                    body=[statement, next_state],
                    orelse=[],
                )
            )

        self.rng.shuffle(blocks)

        chain = [ast.Break()]

        for block in reversed(blocks):
            block.orelse = chain
            chain = [block]

        # For every integer n, n * (n + 1) is even.
        # This branch is unreachable under the dispatch invariant.
        dead_branch = ast.parse(
            f"if ({state} * ({state} + 1)) % 2 != 0:\n"
            f"    {state} ^= {self.rng.randrange(1, 1 << 20)}\n"
        ).body[0]

        initialization = ast.Assign(
            targets=[ast.Name(id=state, ctx=ast.Store())],
            value=ast.Constant(value=labels[0]),
            type_comment=None,
        )

        loop = ast.While(
            test=ast.Compare(
                left=ast.Name(id=state, ctx=ast.Load()),
                ops=[ast.NotEq()],
                comparators=[ast.Constant(value=labels[-1])],
            ),
            body=[dead_branch] + chain,
            orelse=[],
        )

        node.body = prefix + [initialization, loop]
        self.count += 1

        return node


class StringEncoder(ast.NodeTransformer):
    """
    Reversible literal encoding, not cryptographic confidentiality.

    Docstrings, annotations, pattern literals, and literal f-string
    segments are preserved.
    """

    def __init__(self, tree, names, rng):
        self.names = names
        self.rng = rng
        self.alias = names.new()
        self.count = 0
        self.docstrings = set()

        for node in ast.walk(tree):
            if isinstance(
                node,
                (
                    ast.Module,
                    ast.FunctionDef,
                    ast.AsyncFunctionDef,
                    ast.ClassDef,
                ),
            ):
                if node.body and is_docstring(node.body[0]):
                    self.docstrings.add(id(node.body[0].value))

    def visit_Constant(self, node):
        if (
            type(node.value) is not str
            or id(node) in self.docstrings
            or not 0 < len(node.value) <= 2048
        ):
            return node

        key = self.rng.randrange(1, 1 << 16)
        variable = self.names.new()
        encoded = tuple(ord(character) ^ key for character in node.value)

        expression = ast.parse(
            f"''.join({self.alias}.chr({variable} ^ {key}) "
            f"for {variable} in {encoded!r})",
            mode="eval",
        ).body

        self.count += 1
        return ast.copy_location(expression, node)

    def visit_FunctionDef(self, node):
        node.decorator_list = [
            self.visit(item) for item in node.decorator_list
        ]

        node.args.defaults = [
            self.visit(item) for item in node.args.defaults
        ]

        node.args.kw_defaults = [
            self.visit(item) if item is not None else None
            for item in node.args.kw_defaults
        ]

        node.body = [self.visit(item) for item in node.body]

        # Leave return, parameter, and type-parameter annotations intact.
        return node

    visit_AsyncFunctionDef = visit_FunctionDef

    def visit_ClassDef(self, node):
        node.bases = [self.visit(item) for item in node.bases]
        node.keywords = [self.visit(item) for item in node.keywords]
        node.decorator_list = [
            self.visit(item) for item in node.decorator_list
        ]
        node.body = [self.visit(item) for item in node.body]
        return node

    def visit_AnnAssign(self, node):
        node.target = self.visit(node.target)

        if node.value is not None:
            node.value = self.visit(node.value)

        return node

    def visit_TypeAlias(self, node):
        return node

    def visit_JoinedStr(self, node):
        for item in node.values:
            if isinstance(item, ast.FormattedValue):
                item.value = self.visit(item.value)

                if item.format_spec is not None:
                    item.format_spec = self.visit(item.format_spec)

        return node

    def visit_Match(self, node):
        node.subject = self.visit(node.subject)

        for case in node.cases:
            if case.guard is not None:
                case.guard = self.visit(case.guard)

            case.body = [self.visit(item) for item in case.body]

        # Pattern constants must remain syntactic pattern literals.
        return node


def transform(request):
    if sys.version_info < (3, 11):
        raise RuntimeError("Python 3.11 or newer is required.")

    source = request["source"]
    filename = request["filename"]
    mode = request["mode"]
    seed = request["seed"]

    if mode not in {"structural", "lexical", "combined"}:
        raise ValueError("Invalid mode.")

    tree = ast.parse(source, filename=filename, type_comments=True)

    # Compilation validates the original program but does not execute it.
    compile(tree, filename, "exec", dont_inherit=True)
    reject_obvious_reflection(tree)

    rng = random.Random(seed)
    names = Names(source, rng)

    passes = []
    warnings = []
    renamed = 0
    skipped = 0
    flattened = 0
    encoded = 0

    if mode in {"lexical", "combined"}:
        renamer = LocalRenamer(names)
        tree = renamer.visit(tree)
        renamed = renamer.count
        skipped = renamer.skipped
        passes.append("lexical")

        if skipped:
            warnings.append(
                f"{skipped} function scope(s) were left unchanged "
                "by conservative local renaming."
            )

    if mode in {"structural", "combined"}:
        dispatcher = Dispatcher(names, rng)
        tree = dispatcher.visit(tree)
        flattened = dispatcher.count

        encoder = StringEncoder(tree, names, rng)
        tree = encoder.visit(tree)
        encoded = encoder.count

        if encoded:
            insertion = (
                1 if tree.body and is_docstring(tree.body[0]) else 0
            )

            while (
                insertion < len(tree.body)
                and isinstance(tree.body[insertion], ast.ImportFrom)
                and tree.body[insertion].module == "__future__"
            ):
                insertion += 1

            tree.body.insert(
                insertion,
                ast.Import(
                    names=[
                        ast.alias(
                            name="builtins",
                            asname=encoder.alias,
                        )
                    ]
                ),
            )

        passes.append("structural")

        if not flattened:
            warnings.append(
                "No eligible straight-line functions were flattened."
            )

    ast.fix_missing_locations(tree)
    code = ast.unparse(tree) + "\n"

    if source.startswith("#!"):
        code = source.splitlines()[0] + "\n" + code

    # Validate emitted source without executing it.
    compile(code, filename, "exec", dont_inherit=True)

    return {
        "code": code,
        "stats": {
            "passes": passes,
            "renamed": renamed,
            "encodedStrings": encoded,
            "flattenedFunctions": flattened,
            "skippedScopes": skipped,
        },
        "warnings": warnings,
    }


def main():
    request = json.load(sys.stdin)
    result = transform(request)
    print(json.dumps(result, ensure_ascii=True))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(
            json.dumps(
                {
                    "error": (
                        f"{type(error).__name__}: {error}"
                    )
                },
                ensure_ascii=True,
            )
        )
        sys.exit(1)