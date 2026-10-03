// 共用：spawn、來源檔展開（本機 data/，無 PII 寫死）。
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const ROOT = process.cwd();
export const SRC = path.join(ROOT, 'data/2026-09/staff-docs');
export const OUT = path.join(ROOT, 'data/2026-10/staff-import');
export const BIN = path.join(OUT, 'bin/vision-ocr');
export const PDFTOPPM = '/opt/homebrew/bin/pdftoppm';

export function run(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { maxBuffer: undefined } as never);
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    p.on('error', () => resolve({ code: -1, stdout, stderr: 'spawn error' }));
  });
}

export async function exists(p: string) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function sourceFiles(entry: string): Promise<string[]> {
  const full = path.join(SRC, entry);
  const st = await fs.stat(full);
  if (!st.isDirectory()) return [full];
  const inner = (await fs.readdir(full)).filter((f) => /\.(pdf|jpe?g)$/i.test(f)).sort();
  return inner.map((f) => path.join(full, f));
}

