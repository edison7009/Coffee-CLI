import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../../../', import.meta.url), directory = new URL('resources/windows/conpty/', root);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', directory), 'utf8'));
const config = JSON.parse(readFileSync(new URL('tauri.windows.conf.json', root), 'utf8'));
for (const [name, metadata] of Object.entries(manifest.files)) {
  const bytes = readFileSync(new URL(name, directory));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), metadata.sha256, `${name}: pinned runtime integrity`);
  assert.equal(bytes.toString('ascii', 0, 2), 'MZ');
  const pe = bytes.readUInt32LE(0x3c);
  assert.equal(bytes.toString('ascii', pe, pe + 4), 'PE\0\0');
  assert.equal(bytes.readUInt16LE(pe + 4), 0x8664, `${name}: Windows x64 runtime`);
  assert.equal(config.bundle.resources[`resources/windows/conpty/${name}`], name, `${name}: install beside the application`);
}
assert.equal(config.bundle.resources['THIRD_PARTY_NOTICES.md'], 'THIRD_PARTY_NOTICES.md');
assert.equal(config.bundle.resources['resources/windows/conpty/LICENSE.txt'], 'CONPTY-LICENSE.txt');
assert.match(readFileSync(new URL('LICENSE.txt', directory), 'utf8'), /Copyright \(c\) Microsoft Corporation/);
const baseConfig = JSON.parse(readFileSync(new URL('tauri.conf.json', root), 'utf8'));
assert.deepEqual(baseConfig.bundle.resources, ['THIRD_PARTY_NOTICES.md'], 'other platforms do not bundle Windows executables');
if (process.platform === 'win32') {
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
    $ErrorActionPreference='Stop';
    Add-Type 'using System; using System.Runtime.InteropServices; public static class RuntimeProbe {
      [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] public static extern IntPtr LoadLibraryW(string path);
      [DllImport("kernel32.dll",CharSet=CharSet.Ansi)] public static extern IntPtr GetProcAddress(IntPtr module,string name);
      [DllImport("kernel32.dll")] public static extern bool FreeLibrary(IntPtr module);
    }';
    $module=[RuntimeProbe]::LoadLibraryW($env:COFFEE_CONPTY_TEST_DLL);
    if($module -eq [IntPtr]::Zero){throw 'The bundled terminal runtime could not load'};
    try { foreach($name in @('CreatePseudoConsole','ResizePseudoConsole','ClosePseudoConsole')) {
      if([RuntimeProbe]::GetProcAddress($module,$name) -eq [IntPtr]::Zero){throw "Missing terminal entry point: $name"}
    } } finally { [RuntimeProbe]::FreeLibrary($module) | Out-Null };
  `], { stdio: 'inherit', env: { ...process.env, COFFEE_CONPTY_TEST_DLL: fileURLToPath(new URL('conpty.dll', directory)) } });
}
console.log('OK: pinned x64 console runtime, application-directory mapping, license, platform isolation and Windows DLL entry points');
