import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type EvalSuite,
  formatEvalReport,
  loadEvalSuite,
  runEval,
} from '../../../src/retrieval/eval.js';
import { KnowledgeService } from '../../../src/retrieval/knowledge-service.js';
import { E2eProject } from '../../support/e2e-project.js';
import { writeMiniNotes } from '../../support/mini-notes.js';

const thresholds = { recallAt5: 0.5, mrrAt10: 0.5 };

describe('eval', () => {
  let project: E2eProject;
  let service: KnowledgeService;

  beforeAll(async () => {
    project = new E2eProject();
    writeMiniNotes(project.fixture);
    await project.index();
    service = new KnowledgeService(
      project.config,
      project.store,
      project.vectors,
      project.embeddings,
    );
  });

  afterAll(async () => {
    await project.dispose();
  });

  describe('runEval', () => {
    it('measures recall and reciprocal rank and passes above the thresholds', async () => {
      const suite: EvalSuite = {
        thresholds,
        queries: [
          {
            id: 'pasta',
            query: 'spaghetti garlic olive oil',
            expect: ['personal/recipes/pasta.md', 'missing.md'],
          },
          { id: 'embeddings', query: 'Qwen3 vector 1024 numbers', expect: ['embeddings.md:L1'] },
        ],
      };

      const report = await runEval(service, suite);
      const lines = formatEvalReport(report, suite);

      expect(report.results.map((result) => [result.id, result.recallAt5])).toEqual([
        ['pasta', 0.5],
        ['embeddings', 1],
      ]);
      expect(report.passed).toBe(true);
      expect(lines[0]).toMatch(/^part pasta ranks=1,- rr=1\.00 {2}top: personal\/recipes/);
      expect(lines[1]).toBe('ok   embeddings ranks=1 rr=1.00');
      expect(lines).toContain('Recall@5: 0.750 (threshold 0.5) PASS');
      expect(lines.at(-1)).toBe('Evaluation PASSED');
    });

    it('fails when results miss the expectations', async () => {
      const suite: EvalSuite = {
        thresholds,
        queries: [{ id: 'miss', query: 'spaghetti', expect: ['nowhere.md'] }],
      };

      const report = await runEval(service, suite);
      const lines = formatEvalReport(report, suite);

      expect(report).toMatchObject({ recallAt5: 0, mrrAt10: 0, passed: false });
      expect(lines[0]).toMatch(/^MISS miss ranks=- rr=0\.00 {2}top: /);
      expect(lines).toContain('MRR@10: 0.000 (threshold 0.5) FAIL');
      expect(lines.at(-1)).toBe('Evaluation FAILED');
    });
  });

  describe('loadEvalSuite', () => {
    it('validates the reference file, including the shipped example', () => {
      const dir = mkdtempSync(join(tmpdir(), 'md-eval-'));
      const invalid = join(dir, 'invalid.yaml');
      writeFileSync(invalid, 'queries: []\n');

      expect(() => loadEvalSuite(invalid)).toThrow();
      expect(
        loadEvalSuite(join(import.meta.dirname, '../../../eval/example.yaml')).queries.length,
      ).toBe(2);
      rmSync(dir, { recursive: true, force: true });
    });
  });
});
