import { createHash } from 'node:crypto';

export type FindingSeverity = 'info' | 'warning' | 'critical';

export interface DiagnosticFinding {
  code: string;
  severity: FindingSeverity;
  message: string;
  nodePath: string;
  relation?: string;
}

export interface IndexCandidate {
  schema?: string;
  relation: string;
  columns: string[];
  reason: string;
  confidence: 'low' | 'medium';
}

export interface PlanNodeSummary {
  path: string;
  nodeType: string;
  relation?: string;
  index?: string;
  estimatedRows?: number;
  actualRows?: number;
  actualLoops?: number;
  totalCost?: number;
  actualTotalTimeMs?: number;
}

export interface PlanAnalysis {
  summary: {
    totalCost: number | null;
    estimatedRows: number | null;
    actualRows: number | null;
    planningTimeMs: number | null;
    executionTimeMs: number | null;
    nodeCount: number;
    nodeTypes: string[];
    riskScore: number;
  };
  findings: DiagnosticFinding[];
  indexCandidates: IndexCandidate[];
  nodes: PlanNodeSummary[];
}

export interface PlanComparison {
  verdict: 'equivalent' | 'improved' | 'regressed' | 'changed';
  baselineFingerprint: string;
  candidateFingerprint: string;
  structuralChange: boolean;
  deltas: {
    totalCostPercent: number | null;
    planningTimePercent: number | null;
    executionTimePercent: number | null;
    riskScore: number;
    nodeCount: number;
  };
  nodeTypeChanges: Array<{
    nodeType: string;
    baseline: number;
    candidate: number;
    delta: number;
  }>;
  signals: string[];
}

type PlanNode = Record<string, unknown> & { Plans?: PlanNode[] };
type ExplainDocument = Record<string, unknown> & { Plan?: PlanNode };

const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value : undefined;

const relationLabel = (node: PlanNode): string | undefined => {
  const relation = asString(node['Relation Name']);
  if (!relation) return undefined;
  const schema = asString(node.Schema);
  return schema ? `${schema}.${relation}` : relation;
};

const extractFilterColumns = (filter: string): string[] => {
  const columns = new Set<string>();
  const ignored = new Set(['and', 'or', 'not', 'null', 'true', 'false', 'any', 'all']);
  const pattern = /(?:"([^"]+)"|\b([A-Za-z_][A-Za-z0-9_$]*))\s*(?:::?[A-Za-z_][A-Za-z0-9_]*(?:\[\])?)?\s*(?:=|<>|!=|<=|>=|<|>|~~\*?|!~~\*?|\bIS\b|\bIN\b|=\s*ANY\b)/gi;

  for (const match of filter.matchAll(pattern)) {
    const column = (match[1] ?? match[2] ?? '').trim();
    if (column && !ignored.has(column.toLowerCase())) columns.add(column);
  }
  return [...columns].slice(0, 4);
};

export const parseExplainDocument = (rows: Record<string, unknown>[]): ExplainDocument => {
  const firstRow = rows[0];
  if (!firstRow) throw new Error('EXPLAIN returned no rows.');
  const raw = Object.values(firstRow)[0];
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const document = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!document || typeof document !== 'object' || !('Plan' in document)) {
    throw new Error('PostgreSQL returned an unexpected EXPLAIN JSON document.');
  }
  return document as ExplainDocument;
};

export const buildExplainSql = (sql: string, analyze: boolean): string => {
  const options = [
    'FORMAT JSON',
    'COSTS TRUE',
    'VERBOSE FALSE',
    'SETTINGS TRUE',
    'SUMMARY TRUE',
    analyze ? 'ANALYZE TRUE' : 'ANALYZE FALSE',
    analyze ? 'BUFFERS TRUE' : 'BUFFERS FALSE',
    analyze ? 'WAL TRUE' : 'WAL FALSE',
    analyze ? 'TIMING TRUE' : 'TIMING FALSE',
  ];
  return `EXPLAIN (${options.join(', ')}) ${sql}`;
};

export const analyzePlan = (document: ExplainDocument): PlanAnalysis => {
  const findings: DiagnosticFinding[] = [];
  const indexCandidates: IndexCandidate[] = [];
  const nodes: PlanNodeSummary[] = [];
  const nodeTypes = new Set<string>();
  const root = document.Plan;

  if (!root) throw new Error('EXPLAIN document does not contain a root plan.');

  const visit = (node: PlanNode, path: string): void => {
    const nodeType = asString(node['Node Type']) ?? 'Unknown';
    const relation = relationLabel(node);
    const estimatedRows = asNumber(node['Plan Rows']);
    const actualRows = asNumber(node['Actual Rows']);
    const actualLoops = asNumber(node['Actual Loops']);
    const totalCost = asNumber(node['Total Cost']);
    const actualTotalTimeMs = asNumber(node['Actual Total Time']);
    const rowsRemoved = asNumber(node['Rows Removed by Filter']);
    const filter = asString(node.Filter) ?? asString(node['Index Cond']);

    nodeTypes.add(nodeType);
    nodes.push({
      path,
      nodeType,
      relation,
      index: asString(node['Index Name']),
      estimatedRows,
      actualRows,
      actualLoops,
      totalCost,
      actualTotalTimeMs,
    });

    if (nodeType === 'Seq Scan' && relation && Math.max(estimatedRows ?? 0, actualRows ?? 0) >= 1_000) {
      findings.push({
        code: 'large_sequential_scan',
        severity: 'warning',
        message: `${relation} is read with a sequential scan over at least 1,000 rows.`,
        nodePath: path,
        relation,
      });
      if (filter) {
        const columns = extractFilterColumns(filter);
        if (columns.length > 0) {
          const [schema, table] = relation.includes('.') ? relation.split('.', 2) : [undefined, relation];
          indexCandidates.push({
            schema,
            relation: table,
            columns,
            reason: `Sequential scan filter: ${filter}`,
            confidence: 'medium',
          });
        }
      }
    }

    if (actualRows !== undefined && estimatedRows !== undefined && actualRows >= 100) {
      const ratio = Math.max(actualRows, 1) / Math.max(estimatedRows, 1);
      if (ratio >= 10 || ratio <= 0.1) {
        findings.push({
          code: 'row_estimate_mismatch',
          severity: 'warning',
          message: `${nodeType} estimated ${estimatedRows} rows but produced ${actualRows}; consider refreshing statistics or increasing statistics targets.`,
          nodePath: path,
          relation,
        });
      }
    }

    if (rowsRemoved !== undefined && rowsRemoved > Math.max(actualRows ?? 0, 1) * 5) {
      findings.push({
        code: 'rows_removed_by_filter',
        severity: 'warning',
        message: `${nodeType} discarded ${rowsRemoved} rows after filtering.`,
        nodePath: path,
        relation,
      });
    }

    const sortMethod = asString(node['Sort Method']);
    if (sortMethod?.toLowerCase().includes('external')) {
      findings.push({
        code: 'disk_sort',
        severity: 'critical',
        message: `Sort spilled to disk using ${sortMethod}.`,
        nodePath: path,
        relation,
      });
    }

    const tempRead = asNumber(node['Temp Read Blocks']) ?? 0;
    const tempWritten = asNumber(node['Temp Written Blocks']) ?? 0;
    if (tempRead + tempWritten > 0) {
      findings.push({
        code: 'temporary_io',
        severity: 'warning',
        message: `${nodeType} used ${tempRead + tempWritten} temporary blocks.`,
        nodePath: path,
        relation,
      });
    }

    if (
      nodeType === 'Nested Loop' &&
      (actualRows ?? estimatedRows ?? 0) * (actualLoops ?? 1) >= 100_000
    ) {
      findings.push({
        code: 'high_volume_nested_loop',
        severity: 'warning',
        message: 'Nested loop processed at least 100,000 row iterations.',
        nodePath: path,
      });
    }

    const children = Array.isArray(node.Plans) ? node.Plans : [];
    children.forEach((child, index) => visit(child, `${path}.${index + 1}`));
  };

  visit(root, '1');
  const uniqueCandidates = new Map<string, IndexCandidate>();
  for (const candidate of indexCandidates) {
    const key = `${candidate.schema ?? ''}.${candidate.relation}:${candidate.columns.join(',')}`;
    uniqueCandidates.set(key, candidate);
  }

  const riskScore = Math.min(
    100,
    findings.reduce((score, finding) => score + (finding.severity === 'critical' ? 30 : finding.severity === 'warning' ? 12 : 3), 0)
  );

  return {
    summary: {
      totalCost: asNumber(root['Total Cost']) ?? null,
      estimatedRows: asNumber(root['Plan Rows']) ?? null,
      actualRows: asNumber(root['Actual Rows']) ?? null,
      planningTimeMs: asNumber(document['Planning Time']) ?? null,
      executionTimeMs: asNumber(document['Execution Time']) ?? null,
      nodeCount: nodes.length,
      nodeTypes: [...nodeTypes].sort(),
      riskScore,
    },
    findings,
    indexCandidates: [...uniqueCandidates.values()],
    nodes,
  };
};

const normalizeExpression = (value: unknown): string | undefined => {
  const expression = asString(value);
  if (!expression) return undefined;
  return expression
    .replace(/'(?:''|[^'])*'/g, '?')
    .replace(/\b\d+(?:\.\d+)?\b/g, '?')
    .replace(/\s+/g, ' ')
    .trim();
};

const structuralPlanNode = (node: PlanNode): Record<string, unknown> => ({
  nodeType: asString(node['Node Type']) ?? 'Unknown',
  relation: relationLabel(node) ?? null,
  index: asString(node['Index Name']) ?? null,
  joinType: asString(node['Join Type']) ?? null,
  strategy: asString(node.Strategy) ?? null,
  scanDirection: asString(node['Scan Direction']) ?? null,
  indexCondition: normalizeExpression(node['Index Cond']) ?? null,
  filter: normalizeExpression(node.Filter) ?? null,
  hashCondition: normalizeExpression(node['Hash Cond']) ?? null,
  mergeCondition: normalizeExpression(node['Merge Cond']) ?? null,
  children: (Array.isArray(node.Plans) ? node.Plans : []).map(structuralPlanNode),
});

export const planFingerprint = (document: ExplainDocument): string => {
  if (!document.Plan) throw new Error('EXPLAIN document does not contain a root plan.');
  return createHash('sha256').update(JSON.stringify(structuralPlanNode(document.Plan))).digest('hex');
};

const percentChange = (baseline: number | null, candidate: number | null): number | null => {
  if (baseline === null || candidate === null || baseline === 0) return null;
  return Number((((candidate - baseline) / baseline) * 100).toFixed(2));
};

const countNodeTypes = (analysis: PlanAnalysis): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const node of analysis.nodes) counts.set(node.nodeType, (counts.get(node.nodeType) ?? 0) + 1);
  return counts;
};

export const comparePlans = (
  baselineDocument: ExplainDocument,
  candidateDocument: ExplainDocument
): PlanComparison => {
  const baseline = analyzePlan(baselineDocument);
  const candidate = analyzePlan(candidateDocument);
  const baselineFingerprint = planFingerprint(baselineDocument);
  const candidateFingerprint = planFingerprint(candidateDocument);
  const totalCostPercent = percentChange(baseline.summary.totalCost, candidate.summary.totalCost);
  const planningTimePercent = percentChange(
    baseline.summary.planningTimeMs,
    candidate.summary.planningTimeMs
  );
  const executionTimePercent = percentChange(
    baseline.summary.executionTimeMs,
    candidate.summary.executionTimeMs
  );
  const riskDelta = candidate.summary.riskScore - baseline.summary.riskScore;
  const primaryDelta = executionTimePercent ?? totalCostPercent;
  const signals: string[] = [];

  if (totalCostPercent !== null && Math.abs(totalCostPercent) >= 10) {
    signals.push(`Planner cost changed by ${totalCostPercent}%.`);
  }
  if (executionTimePercent !== null && Math.abs(executionTimePercent) >= 10) {
    signals.push(`Measured execution time changed by ${executionTimePercent}%.`);
  }
  if (riskDelta !== 0) signals.push(`Diagnostic risk score changed by ${riskDelta}.`);
  if (baselineFingerprint !== candidateFingerprint) signals.push('The structural plan fingerprint changed.');

  let verdict: PlanComparison['verdict'];
  if (primaryDelta !== null && (primaryDelta >= 20 || riskDelta >= 12)) verdict = 'regressed';
  else if (primaryDelta !== null && primaryDelta <= -20 && riskDelta <= 0) verdict = 'improved';
  else if (baselineFingerprint === candidateFingerprint && (primaryDelta === null || Math.abs(primaryDelta) < 5)) {
    verdict = 'equivalent';
  } else verdict = 'changed';

  const baselineTypes = countNodeTypes(baseline);
  const candidateTypes = countNodeTypes(candidate);
  const allTypes = [...new Set([...baselineTypes.keys(), ...candidateTypes.keys()])].sort();

  return {
    verdict,
    baselineFingerprint,
    candidateFingerprint,
    structuralChange: baselineFingerprint !== candidateFingerprint,
    deltas: {
      totalCostPercent,
      planningTimePercent,
      executionTimePercent,
      riskScore: riskDelta,
      nodeCount: candidate.summary.nodeCount - baseline.summary.nodeCount,
    },
    nodeTypeChanges: allTypes
      .map((nodeType) => {
        const baselineCount = baselineTypes.get(nodeType) ?? 0;
        const candidateCount = candidateTypes.get(nodeType) ?? 0;
        return {
          nodeType,
          baseline: baselineCount,
          candidate: candidateCount,
          delta: candidateCount - baselineCount,
        };
      })
      .filter((item) => item.delta !== 0),
    signals,
  };
};
