// WP-OCR-4.4：真 API schema 實測守則。
//   npx tsx scripts/staff-import/ocr-schema-smoke.ts
// 改過 `ocrJsonSchema`／stage A prompt／欄位 box 結構之後必須跑一次（見 docs/ops.md）：fake client 唯一驗唔到嘅係
// Claude structured output 對 schema 文法大細／結構嘅 400（OCR-5.4 事故：入職表 5 欄＋5 box 令整份退回 DeepSeek）。
// 做法：ImageMagick 生成三張合成圖（白底黑字假表格，冇 PII）→ 各打一次真 Claude stage A（含 box、refs）→ 斷言冇退回後備、
// 解析成功、冇拋錯。key 由 .env 經 dotenv 載入（指定其他檔用 DOTENV_CONFIG_PATH），唔印；console 只印通過／失敗同 token 數。
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OCR_DOC_TYPES, type OcrDocType } from '@/lib/guards/ocr/config';
import { DeepSeekVisionClient } from '@/lib/guards/ocr/vision-client';
import { ClaudeVisionClient } from '@/lib/guards/ocr/claude-vision-client';
import { readStageA } from '@/lib/guards/ocr/read';
import { prepareDocumentImages } from './lib/eval-ocr-images';

const MAGICK = process.env.MAGICK_BIN || '/opt/homebrew/bin/magick';
// ImageMagick 冇預設字體時畫字會失敗；用系統 Arial（可用 SMOKE_FONT 覆蓋）
const FONT = process.env.SMOKE_FONT || '/System/Library/Fonts/Supplemental/Arial.ttf';

/** 合成假表格：標題＋3 行「標籤／虛構值」＋格線。全部虛構（99 開頭號碼、示範街）。 */
const ROWS: Record<OcrDocType, string[]> = {
  id_card: ['Identity Card (SYNTHETIC)', 'Name: TEST SAMPLE', 'ID: Z000000(0)', 'DOB: 01-01-1990'],
  address_proof: ['Address Proof (SYNTHETIC)', 'Name: TEST SAMPLE', 'Address: 99 Sample Road, Test City'],
  onboarding_form: ['Onboarding Form (SYNTHETIC)', 'Name: TEST SAMPLE', 'Phone: 90000000', 'Address: 99 Sample Road, Test City', 'Bank: 000-000000-000'],
};

function magick(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(MAGICK, args, { stdio: 'ignore' });
    p.on('error', () => reject(new Error('magick_missing')));
    p.on('close', (c) => (c === 0 ? resolve() : reject(new Error('magick_failed'))));
  });
}

async function synth(dir: string, type: OcrDocType): Promise<string> {
  const out = path.join(dir, `${type}.png`);
  const rects: string[] = [];
  const texts: string[] = [];
  ROWS[type].forEach((t, i) => {
    const y = 80 + i * 120;
    rects.push('-draw', `rectangle 60,${y - 50} 1140,${y + 30}`);
    texts.push('-draw', `text 80,${y} '${t.replace(/'/g, '')}'`);
  });
  await magick(['-size', '1200x800', 'xc:white', '-fill', 'none', '-stroke', 'black', '-strokewidth', '2', ...rects, '-stroke', 'none', '-fill', 'black', '-font', FONT, '-pointsize', '34', ...texts, out]);
  return out;
}

async function main(): Promise<void> {
  if (!process.env.CLAUDE_API_KEY) {
    console.error('[ocr-schema-smoke] 冇 CLAUDE_API_KEY（.env 或 DOTENV_CONFIG_PATH）');
    process.exit(2);
  }
  const wantDeepseek = !!process.env.DEEPSEEK_API_KEY;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ocr-smoke-'));
  const client = new ClaudeVisionClient();
  let failed = 0;
  let total = 3;
  try {
    for (const type of OCR_DOC_TYPES) {
      try {
        const doc = await prepareDocumentImages(await synth(dir, type));
        // refs 只對有裁圖設計（入職表）生效；用虛構值，令 prompt 帶 refs 區塊
        const r = await readStageA({ a: client, b: client }, type, doc.full, { name_zh: '測試', name_en: 'TEST SAMPLE' });
        const ok = r.parse_ok && r.fallback_reason === null && r.provider === 'claude';
        if (!ok) failed++;
        console.log(`[ocr-schema-smoke] ${type}: ${ok ? 'OK 200' : 'FAIL'}｜parse_ok ${r.parse_ok}｜fallback ${r.fallback_reason ?? 'none'}｜boxes ${Object.keys(r.field_boxes).length}｜tokens in ${r.usage.promptTokens} / out ${r.usage.completionTokens}`);
      } catch (e) {
        failed++;
        const x = e as { status?: number | null; reason?: string | null; errorType?: string | null; errorMessage?: string | null };
        console.log(`[ocr-schema-smoke] ${type}: FAIL｜status ${x.status ?? '-'}｜reason ${x.reason ?? '-'}｜type ${x.errorType ?? '-'}｜${(x.errorMessage ?? (e as Error).message ?? '').slice(0, 300)}`);
      }
    }
    // OCR-5.6：DeepSeek 段落——json_object＋reasoning_effort（預設 low，或 GUARD_OCR_DEEPSEEK_REASONING）要相容、content 非空。
    // 三種文件各一次；入職表另用 5 張裁圖情境（同一合成圖重複 5 次，模擬讀 B 最大輸出）。
    if (wantDeepseek) {
      const ds = new DeepSeekVisionClient();
      for (const type of OCR_DOC_TYPES) {
        try {
          const doc = await prepareDocumentImages(await synth(dir, type));
          const images = type === 'onboarding_form' ? [doc.full, doc.full, doc.full, doc.full, doc.full] : [doc.full];
          const r = await ds.complete({ system: 'Read the form. Reply with a JSON object only: {"name":{"value":"","confidence":"high|medium|low"},"phone":{"value":"","confidence":"high|medium|low"},"address":{"value":"","confidence":"high|medium|low"}}', userText: `Extract the fields from ${images.length} image(s).`, images });
          let json = false;
          try { JSON.parse(r.text); json = true; } catch { /* 唔係 JSON */ }
          const ok = r.text.length > 0 && json && !r.truncated;
          if (!ok) failed++;
          total++;
          console.log(`[ocr-schema-smoke] deepseek ${type}(${images.length} img): ${ok ? 'OK 200' : 'FAIL'}｜content_len ${r.text.length}｜json ${json}｜truncated ${!!r.truncated}｜tokens in ${r.promptTokens} / out ${r.completionTokens}`);
        } catch (e) {
          failed++;
          total++;
          const x = e as { status?: number | null };
          console.log(`[ocr-schema-smoke] deepseek ${type}: FAIL｜status ${x.status ?? '-'}`);
        }
      }
    } else {
      console.log('[ocr-schema-smoke] 冇 DEEPSEEK_API_KEY：略過 DeepSeek 段落');
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  console.log(`[ocr-schema-smoke] ${failed === 0 ? `全部通過（${total}/${total}）` : `失敗 ${failed}/${total}`}`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
