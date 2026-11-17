// SPDX-License-Identifier: AGPL-3.0-only
// A stand-in for an external scanner (gitleaks, osv-scanner) that the product finds on PATH and runs
// directly, with no shell. It is a Node script written to a bin folder, found the way the real tool is:
// on Linux and macOS as an executable file with a `#!/usr/bin/env node` first line; on Windows as
// `<name>.exe`, because a Windows program started without a shell is found only as an .exe, never as an
// extensionless script or a .cmd file.

import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

/** A Windows launcher: starts `node` on the script named in the `.cmdline` file beside it, passes its own
 * arguments on unchanged, and exits with the script's exit code. Kept in a raw string; the C# escapes in it
 * are for the C# compiler. */
const LAUNCHER_SOURCE = String.raw`using System;
using System.Diagnostics;
using System.IO;
using System.Text;

static class Launcher {
  static void Quote(StringBuilder sb, string arg) {
    if (sb.Length > 0) sb.Append(' ');
    if (arg.Length > 0 && arg.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0) { sb.Append(arg); return; }
    sb.Append('"');
    int slashes = 0;
    foreach (char c in arg) {
      if (c == (char)92) { slashes++; continue; }
      if (c == '"') { sb.Append((char)92, slashes * 2 + 1); sb.Append('"'); slashes = 0; continue; }
      sb.Append((char)92, slashes); slashes = 0; sb.Append(c);
    }
    sb.Append((char)92, slashes * 2);
    sb.Append('"');
  }

  static int Main(string[] args) {
    string self = Process.GetCurrentProcess().MainModule.FileName;
    string[] lines = File.ReadAllLines(self + ".cmdline");
    StringBuilder line = new StringBuilder();
    Quote(line, lines[1]);
    foreach (string a in args) Quote(line, a);
    ProcessStartInfo info = new ProcessStartInfo(lines[0], line.ToString());
    info.UseShellExecute = false;
    using (Process p = Process.Start(info)) { p.WaitForExit(); return p.ExitCode; }
  }
}
`;

let launcherExe: string | undefined;

/** Compile the launcher once per machine with the C# compiler every Windows install carries (.NET Framework). */
function windowsLauncher(): string {
  if (launcherExe) return launcherExe;
  const dir = path.join(os.tmpdir(), `miqyas-test-launcher-${createHash('sha256').update(LAUNCHER_SOURCE).digest('hex').slice(0, 12)}`);
  const exe = path.join(dir, 'launcher.exe');
  if (!existsSync(exe)) {
    const root = process.env.SystemRoot;
    const csc = root
      ? ['Framework64', 'Framework'].map((f) => path.join(root, 'Microsoft.NET', f, 'v4.0.30319', 'csc.exe')).find((p) => existsSync(p))
      : undefined;
    if (!csc) throw new Error('The scanner shims need csc.exe from .NET Framework 4, which was not found on this Windows machine.');
    mkdirSync(dir, { recursive: true });
    const unique = `${process.pid}-${Date.now()}`;
    const source = path.join(dir, `launcher-${unique}.cs`);
    const built = path.join(dir, `launcher-${unique}.exe`);
    writeFileSync(source, LAUNCHER_SOURCE, 'utf8');
    try {
      execFileSync(csc, ['/nologo', '/target:exe', '/optimize+', `/out:${built}`, source], { stdio: 'pipe' });
      try {
        renameSync(built, exe);
      } catch (err) {
        // Another test process published the same launcher first; use theirs.
        if (!existsSync(exe)) throw err;
      }
    } finally {
      rmSync(source, { force: true });
      rmSync(built, { force: true });
    }
  }
  launcherExe = exe;
  return exe;
}

/** Write a scanner stand-in named `name` into `binDir`. `script` is the Node script it runs, including its
 * `#!/usr/bin/env node` line. */
export function writeScannerShim(binDir: string, name: 'gitleaks' | 'osv-scanner', script: string): void {
  mkdirSync(binDir, { recursive: true });
  if (process.platform !== 'win32') {
    const shimPath = path.join(binDir, name);
    writeFileSync(shimPath, script, 'utf8');
    chmodSync(shimPath, 0o755);
    return;
  }
  const scriptPath = path.join(binDir, `${name}.shim.cjs`);
  const exePath = path.join(binDir, `${name}.exe`);
  writeFileSync(scriptPath, script, 'utf8');
  copyFileSync(windowsLauncher(), exePath);
  writeFileSync(`${exePath}.cmdline`, `${process.execPath}\n${scriptPath}\n`, 'utf8');
}

/** The current environment with `binDir` first on PATH, joined with the separator this platform uses. */
export function envWithBin(binDir: string): NodeJS.ProcessEnv {
  return { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}` };
}
