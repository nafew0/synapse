import fs from 'node:fs';
import path from 'node:path';
import type { Aggregate, Check, Regression, Report, RunResult } from './types.ts';

const PASS_RATE_DROP = 0.34;
const SCORE_DROP = 1;

const mean = (values: number[]): number | undefined =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;

const round = (value: number | undefined, digits = 2): number | undefined =>
  value == null ? undefined : Math.round(value * 10 ** digits) / 10 ** digits;

export function aggregate(runs: RunResult[]): Aggregate[] {
  const groups = new Map<string, RunResult[]>();
  for (const run of runs) {
    const key = `${run.variantId}\u0000${run.caseId}`;
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }
  return [...groups.values()].map((group) => {
    const passed = group.filter((run) => run.pass).length;
    const scores = group.map((run) => run.judge?.score).filter((score): score is number => !!score);
    const costs = group
      .map((run) => run.usage?.costUsd)
      .filter((cost): cost is number => cost != null);
    return {
      variantId: group[0].variantId,
      caseId: group[0].caseId,
      runs: group.length,
      passed,
      passRate: round(passed / group.length) ?? 0,
      meanScore: round(mean(scores)),
      meanSeconds: Math.round(mean(group.map((run) => run.seconds)) ?? 0),
      meanCostUsd: round(mean(costs), 4),
    };
  });
}

export function compare(current: Aggregate[], baselineFile: string): Regression[] {
  if (!fs.existsSync(baselineFile)) {
    return [];
  }
  const baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8')) as { aggregates: Aggregate[] };
  const previous = new Map(baseline.aggregates.map((a) => [`${a.variantId}\u0000${a.caseId}`, a]));
  return current.flatMap((now) => {
    const before = previous.get(`${now.variantId}\u0000${now.caseId}`);
    if (!before) {
      return [];
    }
    const reasons = [
      before.passRate - now.passRate >= PASS_RATE_DROP
        ? `pass rate ${Math.round(before.passRate * 100)}% → ${Math.round(now.passRate * 100)}%`
        : '',
      before.meanScore != null &&
      now.meanScore != null &&
      before.meanScore - now.meanScore >= SCORE_DROP
        ? `judge score ${before.meanScore} → ${now.meanScore}`
        : '',
    ].filter(Boolean);
    return reasons.length
      ? [{ variantId: now.variantId, caseId: now.caseId, reason: reasons.join('; ') }]
      : [];
  });
}

export function writeBaseline(report: Report, file: string): void {
  fs.writeFileSync(
    file,
    JSON.stringify({ runId: report.runId, aggregates: report.aggregates }, null, 2),
  );
}

interface VariantRow {
  id: string;
  label: string;
  models: string[];
  runs: number;
  passed: number;
  passRate: number;
  score?: number;
  seconds: number;
  cost?: number;
  totalCost: number;
  toolCalls: number;
  healthFailures: number;
}

export function leaderboard(report: Report): VariantRow[] {
  return report.variants
    .map((variant) => {
      const runs = report.runs.filter((run) => run.variantId === variant.id);
      const scores = runs
        .map((run) => run.judge?.score)
        .filter((score): score is number => !!score);
      const costs = runs
        .map((run) => run.usage?.costUsd)
        .filter((cost): cost is number => cost != null);
      const passed = runs.filter((run) => run.pass).length;
      return {
        id: variant.id,
        label: variant.label,
        models: variant.models,
        runs: runs.length,
        passed,
        passRate: runs.length ? passed / runs.length : 0,
        score: round(mean(scores)),
        seconds: Math.round(mean(runs.map((run) => run.seconds)) ?? 0),
        cost: round(mean(costs), 4),
        totalCost: costs.reduce((sum, cost) => sum + cost, 0),
        toolCalls:
          round(
            mean(
              runs.map((run) => run.turns.reduce((sum, turn) => sum + turn.toolCalls.length, 0)),
            ),
          ) ?? 0,
        healthFailures: runs.filter((run) =>
          run.checks.some((check) => check.layer === 'health' && !check.ok),
        ).length,
      };
    })
    .sort(
      (a, b) => b.passRate - a.passRate || (b.score ?? 0) - (a.score ?? 0) || a.seconds - b.seconds,
    );
}

const esc = (value: unknown): string =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const pct = (value: number): string => `${Math.round(value * 100)}%`;
const usd = (value: number | undefined): string =>
  value == null ? '–' : `$${value.toFixed(value < 0.1 ? 4 : 2)}`;
function tone(rate: number): string {
  if (rate >= 0.999) {
    return 'good';
  }
  return rate > 0 ? 'warn' : 'bad';
}
const anchor = (run: RunResult): string => `run-${run.key.replace(/[^a-z0-9-]/gi, '-')}`;

function checkList(checks: Check[]): string {
  const sorted = [...checks].sort((a, b) => Number(a.ok) - Number(b.ok));
  return `<ul class="checks">${sorted
    .map(
      (check) =>
        `<li class="${check.ok ? 'ok' : 'fail'}"><span class="mark">${check.ok ? '✓' : '✗'}</span><span class="layer">${esc(check.layer)}</span>${
          check.turn ? `<span class="layer">turn ${check.turn + 1}</span>` : ''
        }${esc(check.label)}${check.detail ? ` <span class="detail">${esc(check.detail)}</span>` : ''}</li>`,
    )
    .join('')}</ul>`;
}

const list = (title: string, items: string[]): string =>
  items.length
    ? `<p class="detail">${title}</p><ul>${items.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>`
    : '';

function judgeHtml(judgement: RunResult['judge']): string {
  if (!judgement) {
    return '';
  }
  if (judgement.error) {
    return `<p class="detail">${esc(judgement.error)}</p>`;
  }
  return `<div class="judge"><strong>Judge ${judgement.score}/5</strong> <span class="detail">${esc(judgement.model)}</span><p>${esc(
    judgement.summary,
  )}</p>${list('Strengths', judgement.strengths)}${list('Problems', judgement.problems)}</div>`;
}

function runDetail(run: RunResult, outDir: string): string {
  const rel = (file: string) => esc(path.relative(outDir, file));
  const failed = run.checks.filter((check) => !check.ok).length;
  const judge = judgeHtml(run.judge);
  const turns = run.turns
    .map((turn) => {
      const tools = turn.toolCalls.length
        ? `<details><summary>${turn.toolCalls.length} tool call(s): ${esc([...new Set(turn.toolCalls.map((c) => c.name))].join(', '))}</summary><ol class="tools">${turn.toolCalls
            .map(
              (call) =>
                `<li><code>${esc(call.name)}</code> <span class="detail">${esc(call.args.slice(0, 400))}</span></li>`,
            )
            .join('')}</ol></details>`
        : '<p class="detail">No tool calls</p>';
      const questions = turn.questions
        .map(
          (q) => `<p class="detail">Asked: “${esc(q.question)}” → answered “${esc(q.answer)}”</p>`,
        )
        .join('');
      const files = turn.files
        .map(
          (file) =>
            `<div class="file"><a href="${rel(file.path)}">${esc(file.name)}</a> <span class="detail">${esc(file.kind)} · ${Math.round(file.bytes / 1024)} KB${
              file.slides != null ? ` · ${file.slides} slides` : ''
            }${file.pages != null ? ` · ${file.pages} pages` : ''}${file.render_error ? ` · ${esc(file.render_error)}` : ''}</span><div class="thumbs">${file.renders
              .map(
                (render) =>
                  `<a href="${rel(render)}"><img loading="lazy" src="${rel(render)}" alt="${esc(file.name)} render"></a>`,
              )
              .join('')}</div></div>`,
        )
        .join('');
      const missing = turn.attachments
        .filter((a) => a.error)
        .map((a) => `<p class="detail">${esc(a.filename)}: ${esc(a.error)}</p>`)
        .join('');
      return `<section class="turn"><h4>Turn ${turn.index + 1} · ${turn.seconds}s · <code>${esc(turn.conversationId)}</code></h4><p class="prompt">${esc(turn.prompt)}</p>${questions}<pre class="reply">${esc(
        turn.reply || turn.error || '(no reply)',
      )}</pre>${tools}${files}${missing}</section>`;
    })
    .join('');
  const usage = run.usage
    ? ` · ${run.usage.promptTokens + run.usage.completionTokens} tokens · ${usd(run.usage.costUsd)}`
    : '';
  return `<details class="run" id="${anchor(run)}"><summary><span class="badge ${run.pass ? 'good' : 'bad'}">${run.pass ? 'PASS' : 'FAIL'}</span> <strong>${esc(
    run.variantId,
  )}</strong> attempt ${run.attempt} · ${run.seconds}s${usage}${run.judge?.score ? ` · judge ${run.judge.score}/5` : ''}${
    failed ? ` · <span class="bad-text">${failed} failed check(s)</span>` : ''
  }</summary>${checkList(run.checks)}${judge}${turns}</details>`;
}

const STYLE = `
:root{--bg:#f7f7f5;--panel:#fff;--text:#1d1d1b;--muted:#6b6b66;--line:#e3e2dd;--good:#1f7a4d;--good-bg:#e3f3ea;--warn:#8a5a00;--warn-bg:#fbf0d9;--bad:#b42318;--bad-bg:#fbe7e5;--accent:#2f5bd3}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--panel:#1d1d1b;--text:#ecebe6;--muted:#9a9a93;--line:#33332f;--good:#5fd39a;--good-bg:#173527;--warn:#f0c065;--warn-bg:#3a2e14;--bad:#ff8a7a;--bad-bg:#40201c;--accent:#8fa9ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1200px;margin:0 auto;padding:24px 16px 64px}h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:32px 0 10px}h3{font-size:15px;margin:24px 0 8px}h4{font-size:13px;margin:0 0 6px;color:var(--muted);font-weight:500}
.meta,.detail{color:var(--muted)}.detail{font-size:12px}code{font:12px ui-monospace,Menlo,monospace}
.stats{display:flex;flex-wrap:wrap;gap:10px;margin:16px 0}.stat{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:10px 14px;min-width:120px}.stat b{display:block;font-size:20px}
table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:8px;overflow:hidden}th,td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{font-size:12px;color:var(--muted);font-weight:600}
.scroll{overflow-x:auto}.bar{height:6px;background:var(--line);border-radius:3px;margin-top:4px;min-width:80px}.bar span{display:block;height:100%;border-radius:3px;background:var(--good)}
.cell{display:inline-block;padding:2px 8px;border-radius:6px;font-weight:600;text-decoration:none}.good{background:var(--good-bg);color:var(--good)}.warn{background:var(--warn-bg);color:var(--warn)}.bad{background:var(--bad-bg);color:var(--bad)}.bad-text{color:var(--bad)}
.badge{display:inline-block;padding:1px 7px;border-radius:5px;font-size:11px;font-weight:700}
.callout{background:var(--bad-bg);color:var(--bad);border-radius:8px;padding:10px 14px}
details.run{background:var(--panel);border:1px solid var(--line);border-radius:8px;margin:8px 0;padding:8px 12px}details.run>summary{cursor:pointer}
.checks{list-style:none;padding:0;margin:10px 0}.checks li{padding:2px 0}.mark{display:inline-block;width:16px;font-weight:700}.ok .mark{color:var(--good)}.fail .mark{color:var(--bad)}.fail{font-weight:500}
.layer{font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);border:1px solid var(--line);border-radius:4px;padding:0 4px;margin-right:6px}
.judge{border-left:3px solid var(--accent);padding:4px 12px;margin:10px 0}.judge p{margin:4px 0}.judge ul{margin:2px 0 6px;padding-left:18px}
.turn{border-top:1px solid var(--line);padding:10px 0}.prompt{font-weight:500;margin:4px 0}pre.reply{white-space:pre-wrap;background:var(--bg);border-radius:6px;padding:8px 10px;max-height:320px;overflow:auto;font:12px/1.5 ui-monospace,Menlo,monospace}
.tools{font-size:12px;padding-left:20px}.file{margin:8px 0}.thumbs{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}.thumbs img{height:120px;border:1px solid var(--line);border-radius:4px;background:#fff}
a{color:var(--accent)}pre.log{white-space:pre-wrap;font:11px ui-monospace,Menlo,monospace;max-height:400px;overflow:auto;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:10px}
`;

export function renderHtml(report: Report, outDir: string): string {
  const rows = leaderboard(report);
  const passed = report.runs.filter((run) => run.pass).length;
  const totalCost = report.runs.reduce((sum, run) => sum + (run.usage?.costUsd ?? 0), 0);
  const minutes = Math.round(
    (Date.parse(report.finishedAt) - Date.parse(report.startedAt)) / 60000,
  );
  const variantIds = report.variants.map((variant) => variant.id);
  const byKey = new Map(report.aggregates.map((a) => [`${a.variantId}\u0000${a.caseId}`, a]));

  const board = `<div class="scroll"><table><thead><tr><th>#</th><th>Variant</th><th>Models</th><th>Pass rate</th><th>Judge</th><th>Avg time</th><th>Avg tool calls</th><th>Avg cost / run</th><th>Total cost</th><th>Runs with health failures</th></tr></thead><tbody>${rows
    .map(
      (row, index) =>
        `<tr><td>${index + 1}</td><td><strong>${esc(row.label)}</strong><div class="detail">${esc(row.id)}</div></td><td class="detail">${esc(row.models.join(', '))}</td><td>${row.passed}/${row.runs} (${pct(
          row.passRate,
        )})<div class="bar"><span style="width:${pct(row.passRate)}"></span></div></td><td>${row.score ?? '–'}</td><td>${row.seconds}s</td><td>${row.toolCalls}</td><td>${usd(row.cost)}</td><td>${usd(
          row.totalCost,
        )}</td><td>${row.healthFailures}</td></tr>`,
    )
    .join('')}</tbody></table></div>`;

  const matrix = `<div class="scroll"><table><thead><tr><th>Case</th><th>Category</th>${variantIds
    .map((id) => `<th>${esc(id)}</th>`)
    .join('')}</tr></thead><tbody>${report.cases
    .map(
      (item) =>
        `<tr><td><a href="#case-${esc(item.id)}">${esc(item.title)}</a><div class="detail">${esc(item.id)} · ${item.turns} turn(s)</div></td><td class="detail">${esc(item.category)}</td>${variantIds
          .map((id) => {
            const agg = byKey.get(`${id}\u0000${item.id}`);
            if (!agg) {
              return '<td class="detail">–</td>';
            }
            return `<td><span class="cell ${tone(agg.passRate)}">${agg.passed}/${agg.runs}</span>${agg.meanScore != null ? ` <span class="detail">★ ${agg.meanScore}</span>` : ''}<div class="detail">${agg.meanSeconds}s${
              agg.meanCostUsd != null ? ` · ${usd(agg.meanCostUsd)}` : ''
            }</div></td>`;
          })
          .join('')}</tr>`,
    )
    .join('')}</tbody></table></div>`;

  const regressions = report.regressions.length
    ? `<div class="callout"><strong>${report.regressions.length} regression(s) against the baseline</strong><ul>${report.regressions
        .map((r) => `<li>${esc(r.variantId)} · ${esc(r.caseId)}: ${esc(r.reason)}</li>`)
        .join('')}</ul></div>`
    : '';

  const details = report.cases
    .map((item) => {
      const runs = report.runs.filter((run) => run.caseId === item.id);
      return `<h3 id="case-${esc(item.id)}">${esc(item.title)} <span class="detail">${esc(item.category)}</span></h3>${runs.map((run) => runDetail(run, outDir)).join('')}`;
    })
    .join('');

  const errors = report.serverErrors.length
    ? `<h2>Server error log (${report.serverErrors.length} lines during the run)</h2><pre class="log">${esc(report.serverErrors.slice(-200).join('\n'))}</pre>`
    : '';

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Office Eval ${esc(
    report.runId,
  )}</title><style>${STYLE}</style></head><body><main>
<h1>Office Assistant evaluation</h1>
<p class="meta">Run ${esc(report.runId)} · ${esc(report.app.branch)} @ ${esc(report.app.commit)} · ${esc(report.options.mode)} · judge ${esc(report.options.judge ?? 'off')}</p>
<div class="stats"><div class="stat"><b>${passed}/${report.runs.length}</b>runs passed</div><div class="stat"><b>${report.variants.length}</b>variants</div><div class="stat"><b>${report.cases.length}</b>cases</div><div class="stat"><b>${minutes} min</b>wall time</div><div class="stat"><b>${usd(
    totalCost,
  )}</b>model spend</div><div class="stat"><b>${usd(report.judgeCostUsd)}</b>judge spend</div></div>
${regressions}
<h2>Variants</h2>${board}
<h2>Cases × variants</h2>${matrix}
<h2>Runs</h2>${details}
${errors}
</main></body></html>`;
}

export function writeReport(report: Report, outDir: string): { json: string; html: string } {
  const json = path.join(outDir, 'report.json');
  const html = path.join(outDir, 'report.html');
  fs.writeFileSync(json, JSON.stringify(report, null, 2));
  fs.writeFileSync(html, renderHtml(report, outDir));
  return { json, html };
}

export function summary(report: Report): string {
  const rows = leaderboard(report);
  const lines = rows.map(
    (row, index) =>
      `${String(index + 1).padStart(2)}. ${row.id.padEnd(18)} ${`${row.passed}/${row.runs}`.padStart(7)} ${pct(row.passRate).padStart(5)}  judge ${String(row.score ?? '–').padStart(4)}  ${String(row.seconds).padStart(4)}s  ${usd(row.cost).padStart(8)}/run`,
  );
  const failures = report.runs
    .filter((run) => !run.pass)
    .map((run) => {
      const first = run.checks.find((check) => !check.ok);
      const reason = first
        ? `${first.label}${first.detail ? ` (${first.detail})` : ''}`
        : `judge ${run.judge?.score ?? '?'}/5`;
      return `  ✗ ${run.variantId} · ${run.caseId} #${run.attempt}: ${reason.slice(0, 160)}`;
    });
  const regressions = report.regressions.map(
    (r) => `  ↓ ${r.variantId} · ${r.caseId}: ${r.reason}`,
  );
  return [
    'Variants (best first)',
    ...lines,
    ...(failures.length ? ['', 'Failed runs', ...failures] : []),
    ...(regressions.length ? ['', 'Regressions against the baseline', ...regressions] : []),
  ].join('\n');
}
