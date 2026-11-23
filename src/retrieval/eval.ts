import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { KnowledgeService } from './knowledge-service.js';

export const evalSuiteSchema = z.strictObject({
  thresholds: z.strictObject({
    recallAt5: z.number().min(0).max(1),
    mrrAt10: z.number().min(0).max(1),
  }),
  queries: z
    .array(
      z.strictObject({
        id: z.string().min(1),
        query: z.string().min(1),
        /** Substrings of the expected result locations (`folder/note.md`, `note.md:L12`). */
        expect: z.array(z.string().min(1)).min(1),
      }),
    )
    .min(1),
});

export type EvalSuite = z.infer<typeof evalSuiteSchema>;
export type EvalQuery = EvalSuite['queries'][number];

export interface QueryResult {
  readonly id: string;
  /** 1-based rank of each expected path in the results, null when absent. */
  readonly ranks: readonly (number | null)[];
  readonly recallAt5: number;
  readonly reciprocalRank: number;
  readonly top: readonly string[];
}

export interface EvalReport {
  readonly results: readonly QueryResult[];
  readonly recallAt5: number;
  readonly mrrAt10: number;
  readonly passed: boolean;
}

export function loadEvalSuite(path: string): EvalSuite {
  return evalSuiteSchema.parse(parseYaml(readFileSync(path, 'utf8')));
}

const mean = (values: readonly number[]): number =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

/** Runs the reference queries and computes retrieval metrics. */
export async function runEval(service: KnowledgeService, suite: EvalSuite): Promise<EvalReport> {
  const results: QueryResult[] = [];
  for (const query of suite.queries) {
    const found = (await service.search(query.query, { limit: 10, maxContextChars: 0 })).map(
      (hit) => hit.location,
    );
    const ranks = query.expect.map((expected) => {
      const index = found.findIndex((location) => location.includes(expected));
      return index === -1 ? null : index + 1;
    });
    const hits = ranks.filter((rank): rank is number => rank !== null);
    results.push({
      id: query.id,
      ranks,
      recallAt5: hits.filter((rank) => rank <= 5).length / ranks.length,
      reciprocalRank: hits.length === 0 ? 0 : 1 / Math.min(...hits),
      top: found.slice(0, 3),
    });
  }
  const recallAt5 = mean(results.map((result) => result.recallAt5));
  const mrrAt10 = mean(results.map((result) => result.reciprocalRank));
  const { thresholds } = suite;
  return {
    results,
    recallAt5,
    mrrAt10,
    passed: recallAt5 >= thresholds.recallAt5 && mrrAt10 >= thresholds.mrrAt10,
  };
}

export function formatEvalReport(report: EvalReport, suite: EvalSuite): string[] {
  const lines = report.results.map((result) => {
    const ranks = result.ranks.map((rank) => (rank === null ? '-' : String(rank))).join(',');
    const ok = result.recallAt5 === 1 ? 'ok  ' : result.recallAt5 > 0 ? 'part' : 'MISS';
    return `${ok} ${result.id} ranks=${ranks} rr=${result.reciprocalRank.toFixed(2)}${
      result.recallAt5 < 1 ? `  top: ${result.top.join(' | ')}` : ''
    }`;
  });
  const { thresholds } = suite;
  const metric = (name: string, value: number, threshold: number) =>
    `${name}: ${value.toFixed(3)} (threshold ${threshold}) ${value >= threshold ? 'PASS' : 'FAIL'}`;
  return [
    ...lines,
    metric('Recall@5', report.recallAt5, thresholds.recallAt5),
    metric('MRR@10', report.mrrAt10, thresholds.mrrAt10),
    report.passed ? 'Evaluation PASSED' : 'Evaluation FAILED',
  ];
}
