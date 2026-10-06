const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");

/** Compile the actual TS source in memory; no dependency install or build files. */
function loadSource(relativePath, mocks = {}) {
  const cache = new Map();
  function load(filename) {
    if (cache.has(filename)) return cache.get(filename).exports;
    const source = fs.readFileSync(filename, "utf8");
    const output = ts.transpileModule(source, {
      fileName: filename,
      compilerOptions: {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
      },
    }).outputText;
    const mod = new Module(filename, module);
    mod.filename = filename;
    mod.paths = Module._nodeModulePaths(path.dirname(filename));
    mod.require = (specifier) => {
      if (Object.prototype.hasOwnProperty.call(mocks, specifier)) return mocks[specifier];
      if (specifier.startsWith(".")) {
        const resolved = path.resolve(path.dirname(filename), specifier);
        const target = [resolved, `${resolved}.ts`, `${resolved}.tsx`].find((candidate) =>
          fs.existsSync(candidate) && fs.statSync(candidate).isFile());
        if (target?.endsWith(".ts") || target?.endsWith(".tsx")) return load(target);
      }
      return Module.prototype.require.call(mod, specifier);
    };
    cache.set(filename, mod);
    mod._compile(output, filename);
    return mod.exports;
  }
  return load(path.resolve(__dirname, "..", relativePath));
}

module.exports = { loadSource };
