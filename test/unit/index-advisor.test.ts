import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildIndexSql,
  calculateHypotheticalBenefit,
  findCoveringIndex,
  recommendationConfidence,
  type ExistingIndex,
} from '../../src/index-advisor.js';

const index = (overrides: Partial<ExistingIndex> = {}): ExistingIndex => ({
  indexName: 'events_account_created_idx',
  definition: 'CREATE INDEX events_account_created_idx ON public.events (account_id, created_at)',
  keyColumns: ['account_id', 'created_at'],
  predicate: null,
  isValid: true,
  isReady: true,
  scans: 20,
  ...overrides,
});

test('detects left-prefix coverage by a valid existing index', () => {
  assert.equal(findCoveringIndex(['account_id'], [index()])?.indexName, 'events_account_created_idx');
  assert.equal(findCoveringIndex(['created_at'], [index()]), undefined);
  assert.equal(findCoveringIndex(['account_id'], [index({ predicate: 'active' })]), undefined);
});

test('builds quoted advisory and hypothetical index SQL', () => {
  assert.equal(
    buildIndexSql('Sales Data', 'Order', ['Customer ID'], true),
    'CREATE INDEX CONCURRENTLY "idx_order_customer_id" ON "Sales Data"."Order" ("Customer ID")'
  );
});

test('scores measured hypothetical index benefits', () => {
  const benefit = calculateHypotheticalBenefit(1000, 200, true);
  assert.equal(benefit.costReductionPercent, 80);
  assert.equal(recommendationConfidence(benefit, 2), 'high');
  assert.equal(recommendationConfidence(null, 5), 'medium');
});
