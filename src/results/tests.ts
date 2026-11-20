import { stripAnsi } from '../agents/types.js';

export interface TestSummary {
  readonly passed: number | null;
  readonly failed: number | null;
  readonly skipped: number | null;
  /** Which output format was recognised, if any. */
  readonly format: 'vitest' | 'jest' | 'pytest' | 'mocha' | 'go' | 'cargo' | null;
}

const num = (v: string | undefined): number | null => (v === undefined ? null : Number(v));

/**
 * Best-effort extraction of pass/fail counts from common test runners. The exit code of the
 * verification command remains the source of truth; counts are informational.
 */
export function parseTestSummary(output: string): TestSummary {
  const text = stripAnsi(output);
  let m = /Tests\s+(?:(\d+)\s+failed\s*\|\s*)?(\d+)\s+passed(?:\s*\|\s*(\d+)\s+skipped)?/i.exec(
    text,
  );
  if (m !== null && /Test Files/i.test(text)) {
    return { passed: num(m[2]), failed: num(m[1]) ?? 0, skipped: num(m[3]) ?? 0, format: 'vitest' };
  }
  m =
    /Tests:\s+(?:(\d+)\s+failed,\s+)?(?:(\d+)\s+skipped,\s+)?(?:(\d+)\s+passed,\s+)?\d+\s+total/i.exec(
      text,
    );
  if (m !== null)
    return {
      passed: num(m[3]) ?? 0,
      failed: num(m[1]) ?? 0,
      skipped: num(m[2]) ?? 0,
      format: 'jest',
    };
  m = /=+ (?:(\d+) failed)?(?:, )?(?:(\d+) passed)?(?:, )?(?:(\d+) skipped)?.* in [\d.]+s/i.exec(
    text,
  );
  if (m !== null && (m[1] !== undefined || m[2] !== undefined)) {
    return {
      passed: num(m[2]) ?? 0,
      failed: num(m[1]) ?? 0,
      skipped: num(m[3]) ?? 0,
      format: 'pytest',
    };
  }
  m = /(\d+) passing[\s\S]*?(?:(\d+) pending)?[\s\S]*?(?:(\d+) failing)?\s*$/i.exec(text);
  if (m !== null && /passing \(/.test(text)) {
    return { passed: num(m[1]), failed: num(m[3]) ?? 0, skipped: num(m[2]) ?? 0, format: 'mocha' };
  }
  m = /test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored/i.exec(text);
  if (m !== null)
    return { passed: num(m[1]), failed: num(m[2]), skipped: num(m[3]), format: 'cargo' };
  if (/^(ok|FAIL)\s+\S+\s+[\d.]+s$/m.test(text)) {
    const failed = (text.match(/^FAIL\s+\S+/gm) ?? []).length;
    const passed = (text.match(/^ok\s+\S+/gm) ?? []).length;
    return { passed, failed, skipped: null, format: 'go' };
  }
  return { passed: null, failed: null, skipped: null, format: null };
}
