// The ACP tool list (src/lib/acp-tools.ts) for tests that run app-state's reducer on its own: the reducer asks it
// which tools keep an ACP view. Loaded from the source, so the tests never hold a second copy of the list.
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const module = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL('../src/lib/acp-tools.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText, { module, exports: module.exports, localStorage: { getItem: () => null } });
export const { isAcpTool, ACP_TOOLS } = module.exports;
