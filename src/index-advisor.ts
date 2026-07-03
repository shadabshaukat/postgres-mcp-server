import { createHash } from 'node:crypto';

export interface ExistingIndex {
  indexName: string;
  definition: string;
  keyColumns: string[];
  predicate: string | null;
  isValid: boolean;
  isReady: boolean;
  scans: number;
}

export interface HypotheticalBenefit {
  baselineCost: number | null;
  hypotheticalCost: number | null;
  costReductionPercent: number | null;
  usedHypotheticalIndex: boolean;
}

export const quoteIdentifier = (value: string): string => `"${value.replace(/"/g, '""')}"`;

const normalizeIdentifier = (value: string): string =>
  value
    .trim()
    .replace(/^"|"$/g, '')
    .replace(/""/g, '"')
    .toLowerCase();

export const findCoveringIndex = (
  columns: string[],
  indexes: ExistingIndex[]
): ExistingIndex | undefined => {
  const requested = columns.map(normalizeIdentifier);
  return indexes.find((index) => {
    if (!index.isValid || !index.isReady || index.predicate) return false;
    const keys = index.keyColumns.map(normalizeIdentifier);
    return requested.every((column, position) => keys[position] === column);
  });
};

const indexName = (relation: string, columns: string[]): string => {
  const base = `idx_${relation}_${columns.join('_')}`
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (base.length <= 55) return base;
  const suffix = createHash('sha1').update(base).digest('hex').slice(0, 7);
  return `${base.slice(0, 47)}_${suffix}`;
};

export const buildIndexSql = (
  schema: string,
  relation: string,
  columns: string[],
  concurrently: boolean
): string => {
  const name = quoteIdentifier(indexName(relation, columns));
  const table = `${quoteIdentifier(schema)}.${quoteIdentifier(relation)}`;
  const keys = columns.map(quoteIdentifier).join(', ');
  return `CREATE INDEX${concurrently ? ' CONCURRENTLY' : ''} ${name} ON ${table} (${keys})`;
};

export const calculateHypotheticalBenefit = (
  baselineCost: number | null,
  hypotheticalCost: number | null,
  usedHypotheticalIndex: boolean
): HypotheticalBenefit => {
  const costReductionPercent =
    baselineCost !== null && hypotheticalCost !== null && baselineCost > 0
      ? Number((((baselineCost - hypotheticalCost) / baselineCost) * 100).toFixed(2))
      : null;
  return { baselineCost, hypotheticalCost, costReductionPercent, usedHypotheticalIndex };
};

export const recommendationConfidence = (
  benefit: HypotheticalBenefit | null,
  selectivityPercent: number | null
): 'low' | 'medium' | 'high' => {
  if (benefit?.usedHypotheticalIndex && (benefit.costReductionPercent ?? 0) >= 30) return 'high';
  if (benefit?.usedHypotheticalIndex && (benefit.costReductionPercent ?? 0) >= 10) return 'medium';
  if (selectivityPercent !== null && selectivityPercent <= 10) return 'medium';
  return 'low';
};
