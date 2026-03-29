import type { EvalReport, FixtureResult } from "./fixture-types";

/**
 * Build an aggregate EvalReport from individual fixture results.
 */
export function buildReport(results: FixtureResult[]): EvalReport {
  const n = results.length;
  if (n === 0) {
    return {
      timestamp: new Date().toISOString(),
      fixture_count: 0,
      results: [],
      aggregate: {
        constraint_precision: 0,
        constraint_recall: 0,
        hit_at_1: 0,
        hit_at_3: 0,
        hit_at_5: 0,
        exclusion_compliance: 0,
        ordering_accuracy: 0,
        validation_pass_rate: 0,
        avg_duration_ms: 0,
      },
    };
  }

  const avg = (vals: number[]) => vals.reduce((a, b) => a + b, 0) / vals.length;
  const boolRate = (vals: boolean[]) => vals.filter(Boolean).length / vals.length;

  return {
    timestamp: new Date().toISOString(),
    fixture_count: n,
    results,
    aggregate: {
      constraint_precision: avg(results.map((r) => r.metrics.constraint_precision)),
      constraint_recall: avg(results.map((r) => r.metrics.constraint_recall)),
      hit_at_1: boolRate(results.map((r) => r.metrics.hit_at_1)),
      hit_at_3: boolRate(results.map((r) => r.metrics.hit_at_3)),
      hit_at_5: boolRate(results.map((r) => r.metrics.hit_at_5)),
      exclusion_compliance: boolRate(results.map((r) => r.metrics.exclusion_compliance)),
      ordering_accuracy: avg(results.map((r) => r.metrics.ordering_accuracy)),
      validation_pass_rate: boolRate(results.map((r) => r.metrics.validation_passed)),
      avg_duration_ms: avg(results.map((r) => r.duration_ms)),
    },
  };
}

/**
 * Format report as console-friendly table.
 */
export function formatReport(report: EvalReport): string {
  const lines: string[] = [];
  const hr = "═".repeat(100);

  lines.push(hr);
  lines.push(`  EVAL REPORT — ${report.timestamp}`);
  lines.push(`  ${report.fixture_count} fixtures evaluated`);
  lines.push(hr);
  lines.push("");

  // Per-fixture table
  const header = [
    "Fixture".padEnd(28),
    "Constraint".padEnd(12),
    "Hit@1".padEnd(7),
    "Hit@3".padEnd(7),
    "Hit@5".padEnd(7),
    "Primary".padEnd(9),
    "Excl.".padEnd(7),
    "Valid".padEnd(7),
    "Time".padEnd(8),
  ].join("│");

  lines.push("  " + header);
  lines.push("  " + "─".repeat(header.length));

  for (const r of report.results) {
    const name = r.fixture_name.slice(0, 26).padEnd(28);
    const constr = (r.metrics.constraint_precision === 1 && r.metrics.constraint_recall === 1 ? "PASS" : "FAIL").padEnd(12);
    const h1 = (r.metrics.hit_at_1 ? "PASS" : "FAIL").padEnd(7);
    const h3 = (r.metrics.hit_at_3 ? "PASS" : "FAIL").padEnd(7);
    const h5 = (r.metrics.hit_at_5 ? "PASS" : "FAIL").padEnd(7);
    const primary = `#${r.primary_card_id}`.padEnd(9);
    const excl = (r.metrics.exclusion_compliance ? "PASS" : "FAIL").padEnd(7);
    const valid = (r.metrics.validation_passed ? "PASS" : "FAIL").padEnd(7);
    const time = `${(r.duration_ms / 1000).toFixed(1)}s`.padEnd(8);

    lines.push(`  ${name}│${constr}│${h1}│${h3}│${h5}│${primary}│${excl}│${valid}│${time}`);

    // Show validation errors if any
    for (const [step, errs] of Object.entries(r.validation_errors)) {
      for (const err of errs) {
        lines.push(`    ⚠ [${step}] ${err}`);
      }
    }
  }

  lines.push("");
  lines.push(hr);
  lines.push("  AGGREGATE METRICS");
  lines.push(hr);

  const a = report.aggregate;
  lines.push(`  Constraint Precision: ${(a.constraint_precision * 100).toFixed(0)}%    Recall: ${(a.constraint_recall * 100).toFixed(0)}%`);
  lines.push(`  Hit@1: ${(a.hit_at_1 * 100).toFixed(0)}%    Hit@3: ${(a.hit_at_3 * 100).toFixed(0)}%    Hit@5: ${(a.hit_at_5 * 100).toFixed(0)}%`);
  lines.push(`  Exclusion Compliance: ${(a.exclusion_compliance * 100).toFixed(0)}%`);
  lines.push(`  Ordering Accuracy: ${(a.ordering_accuracy * 100).toFixed(0)}%`);
  lines.push(`  Validation Pass Rate: ${(a.validation_pass_rate * 100).toFixed(0)}%`);
  lines.push(`  Avg Pipeline Duration: ${(a.avg_duration_ms / 1000).toFixed(1)}s`);
  lines.push("");

  // Overall pass/fail
  const passing = report.results.filter(
    (r) =>
      r.metrics.constraint_precision === 1 &&
      r.metrics.constraint_recall === 1 &&
      r.metrics.exclusion_compliance
  ).length;
  lines.push(`  Overall: ${passing}/${report.fixture_count} fixtures PASS core checks`);
  lines.push(hr);

  return lines.join("\n");
}
