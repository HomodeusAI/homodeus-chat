import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Lightweight fidelity check for the Hermes plugin adapter: it must parse and expose its plugin
// surface. We can't import it (the gateway.* modules only exist inside a running Hermes), so we
// AST-parse instead, which still catches syntax errors and a drifted base class / missing methods.

const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = join(here, "..", "hermes-plugin", "homodeus-chat");

function findPython(): string | null {
  for (const bin of ["python3", "python"]) {
    try {
      execFileSync(bin, ["--version"], { stdio: "ignore" });
      return bin;
    } catch {
      /* try next */
    }
  }
  return null;
}

const py = findPython();

const CHECK = `
import ast, sys
adapter, init = sys.argv[1], sys.argv[2]
ast.parse(open(init).read(), init)            # __init__.py parses
tree = ast.parse(open(adapter).read(), adapter)
classes = {n.name: n for n in ast.walk(tree) if isinstance(n, ast.ClassDef)}
funcs = {n.name for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))}
assert "HomodeusChatAdapter" in classes, "missing HomodeusChatAdapter"
bases = {b.id for b in classes["HomodeusChatAdapter"].bases if isinstance(b, ast.Name)}
assert "BasePlatformAdapter" in bases, "adapter must subclass BasePlatformAdapter"
need = {"register", "check_requirements", "connect", "disconnect", "send", "get_chat_info"}
missing = need - funcs
assert not missing, "missing: " + ",".join(sorted(missing))
print("ok")
`;

test("the Hermes plugin adapter parses and keeps its plugin surface", { skip: py ? false : "python not found" }, () => {
  const out = execFileSync(py!, ["-c", CHECK, join(pluginDir, "adapter.py"), join(pluginDir, "__init__.py")], {
    encoding: "utf8",
  });
  assert.match(out, /ok/);
});
