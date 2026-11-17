// SPDX-License-Identifier: AGPL-3.0-only
// A stand-in for an external scanner (gitleaks, osv-scanner) that the product finds on PATH and runs
// directly, with no shell. It is a Node script written to a bin folder, found the way the real tool is:
// on Linux and macOS as an executable file with a `#!/usr/bin/env node` first line; on Windows as
// `<name>.exe`, because a Windows program started without a shell is found only as an .exe, never as an
// extensionless script or a .cmd file.

import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';

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
let launcherDir: string | undefined;

// vitest evaluates this module once per test file that imports it, so each file compiles into its own folder and
// removes only that folder when its tests finish. (A worker is killed hard, so a process exit handler never runs.)
if (process.platform === 'win32') {
  afterAll(() => {
    if (launcherDir) rmSync(launcherDir, { recursive: true, force: true });
  });
}

/** Compile the launcher once per test file, into a private folder made for it and removed when its tests finish, with the C# compiler every Windows install carries (.NET Framework). */
function windowsLauncher(): string {
  if (launcherExe) return launcherExe;
  const root = process.env.SystemRoot;
  const csc = root
    ? ['Framework64', 'Framework'].map((f) => path.join(root, 'Microsoft.NET', f, 'v4.0.30319', 'csc.exe')).find((p) => existsSync(p))
    : undefined;
  if (!csc) throw new Error('The scanner shims need csc.exe from .NET Framework 4, which was not found on this Windows machine.');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'miqyas-launcher-'));
  launcherDir = dir;
  const source = path.join(dir, 'launcher.cs');
  const exe = path.join(dir, 'launcher.exe');
  writeFileSync(source, LAUNCHER_SOURCE, 'utf8');
  execFileSync(csc, ['/nologo', '/target:exe', '/optimize+', `/out:${exe}`, source], { stdio: 'pipe' });
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
  // `.cmdline` format: line 1 is the full path of the program to start (node), line 2 the script it runs.
  writeFileSync(`${exePath}.cmdline`, `${process.execPath}\n${scriptPath}\n`, 'utf8');
}

/** The current environment with `binDir` first on PATH, joined with the separator this platform uses. */
export function envWithBin(binDir: string): NodeJS.ProcessEnv {
  return { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}` };
}
