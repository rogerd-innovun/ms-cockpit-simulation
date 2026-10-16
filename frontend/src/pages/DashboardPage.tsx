import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { duration, pct } from '../lib/format';
import type { DashboardData } from '../lib/types';

const PERIODS = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 0, label: 'All time' },
];

/** Where the work sits now, in the same groups the worklist tabs use, each linking to its tab. */
const PIPELINE: { label: string; statuses: string[]; view?: string; tone: string }[] = [
  { label: 'Incoming', statuses: ['DRAFT', 'PUBLISHED', 'PROCESSING'], view: 'draft', tone: 't-info' },
  { label: 'Waiting for review', statuses: ['NEEDS_REVIEW'], view: 'review', tone: 't-warn' },
  { label: 'With SAP', statuses: ['APPROVED', 'SENT_TO_SAP'], view: 'inflight', tone: 't-info' },
  { label: 'Needs attention', statuses: ['FAILED', 'EXTRACTION_FAILED'], view: 'failed', tone: 't-crit' },
  { label: 'Sales Order created', statuses: ['SO_CREATED'], view: 'done', tone: 't-ok' },
  { label: 'Cancelled', statuses: ['CANCELLED'], tone: 't-idle' },
];

export function DashboardPage() {
  const [params, setParams] = useSearchParams();
  const asked = Number(params.get('days') ?? 30);
  const days = PERIODS.some((p) => p.days === asked) ? asked : 30;

  const q = useQuery({
    queryKey: ['dashboard', days],
    queryFn: () => api.dashboard(days),
    refetchInterval: 30_000,
  });
  const d = q.data;

  return (
    <div className="sheet">
      <div className="head">
        <div className="head-row">
          <div>
            <h1>Dashboard</h1>
            <p className="cap">
              {days === 0 ? 'Every PO uploaded' : `POs uploaded in the last ${days} days`}, followed to wherever each one got to.
              {d && <> Updated {new Date(d.generatedAt).toLocaleTimeString()}.</>}
            </p>
          </div>
          <div className="spacer" />
          <div className="tabs" role="group" aria-label="Period">
            {PERIODS.map((p) => (
              <button
                key={p.days}
                className="tab t-idle"
                aria-pressed={days === p.days}
                onClick={() => setParams(p.days === 30 ? {} : { days: String(p.days) }, { replace: true })}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {q.isLoading && <div className="empty">Loading the dashboard…</div>}
      {q.isError && <div className="err" role="alert">The dashboard could not be loaded. It will try again on its own.</div>}
      {d && <Body d={d} />}
    </div>
  );
}

function Body({ d }: { d: DashboardData }) {
  const st = d.straightThrough;
  const c = d.caught;
  const rej = d.sapRejections;

  return (
    <>
      {d.uploaded === 0 && (
        <div className="notice" style={{ marginTop: 18 }}>
          <b>No POs were uploaded in this period</b>
          <span>Pick a longer period, or upload some from the worklist. The figures below fill in as POs move through.</span>
        </div>
      )}

      <div className="kpis">
        <Kpi
          label="POs processed"
          value={String(d.read)}
          sub={`of ${d.uploaded} uploaded · ${d.approved} approved · ${d.soCreated} Sales Order${d.soCreated === 1 ? '' : 's'} created`}
        />
        <Kpi
          label="Handled with no edits"
          value={pct(st.rate)}
          sub={st.of === 0 ? 'Nothing approved yet' : `${st.count} of ${st.of} approved POs needed no correction`}
          tone={st.rate == null ? undefined : st.rate >= 0.8 ? 't-ok' : st.rate >= 0.5 ? 't-warn' : 't-crit'}
        />
        <Kpi
          label="Time saved"
          value={duration(d.minutesSaved.total)}
          sub={d.minutesSaved.perPo == null ? 'Nothing approved yet' : `about ${duration(d.minutesSaved.perPo)} per PO`}
          note="estimate"
          tone="t-ok"
        />
        <Kpi
          label="Caught before SAP"
          value={String(c.recordsIntercepted)}
          sub={`${c.sentBack} sent back · ${c.corrections} field${c.corrections === 1 ? '' : 's'} corrected`}
          tone={c.recordsIntercepted > 0 ? 't-warn' : undefined}
        />
        <Kpi
          label="Rejected by SAP"
          value={String(rej.total)}
          sub={rej.total === 0 ? 'None' : `${rej.recovered} of ${rej.recordsRejected} PO${rej.recordsRejected === 1 ? '' : 's'} since fixed`}
          tone={rej.total > 0 ? 't-crit' : 't-ok'}
        />
      </div>

      <section className="sec">
        <div className="sec-head">
          <h2>Throughput</h2>
          <div className="spacer" />
          <span className="legend">
            <i className="swatch up" /> uploaded
            <i className="swatch done" /> Sales Order created
          </span>
        </div>
        <Throughput daily={d.daily} />
      </section>

      <div className="dash-cols">
        <section className="sec">
          <div className="sec-head"><h2>Where the work is now</h2></div>
          <ul className="stat-list">
            {PIPELINE.map((row) => {
              const n = row.statuses.reduce((sum, s) => sum + (d.pipeline[s] ?? 0), 0);
              return (
                <li key={row.label} className={row.tone}>
                  <span className="lamp" aria-hidden="true" />
                  {row.view ? <Link to={`/?view=${row.view}`}>{row.label}</Link> : <span>{row.label}</span>}
                  <span className="spacer" />
                  <b className="tnum">{n}</b>
                </li>
              );
            })}
          </ul>
          <p className="cap" style={{ marginTop: 8 }}>Right now, across every PO, whatever the period above.</p>
        </section>

        <section className="sec">
          <div className="sec-head"><h2>Caught before SAP</h2></div>
          <ul className="stat-list">
            <li><span>Sent back by a reviewer</span><span className="spacer" /><b className="tnum">{c.sentBack}</b><span className="cap">on {c.recordsSentBack} PO{c.recordsSentBack === 1 ? '' : 's'}</span></li>
            <li><span>Fields a reviewer corrected</span><span className="spacer" /><b className="tnum">{c.corrections}</b><span className="cap">on {c.recordsCorrected} PO{c.recordsCorrected === 1 ? '' : 's'}</span></li>
            <li><span>Warnings a person had to accept</span><span className="spacer" /><b className="tnum">{c.warningsAccepted}</b></li>
          </ul>
          <div className="sec-head" style={{ marginTop: 22 }}><h2>Rejected by SAP</h2></div>
          {rej.byCode.length === 0 ? (
            <p className="cap">None in this period.</p>
          ) : (
            <ul className="stat-list">
              {rej.byCode.map((r) => (
                <li key={r.code}><span className="mono">{r.code}</span><span className="spacer" /><b className="tnum">{r.count}</b></li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="sec">
        <div className="sec-head"><h2>How well it reads</h2></div>
        <div className="kpis quiet">
          <Kpi
            label="Field accuracy"
            value={pct(d.quality.accuracy)}
            sub={d.quality.fieldsRead === 0 ? 'Nothing read yet' : `${d.quality.fieldsCorrected} of ${d.quality.fieldsRead} readings corrected by a person`}
            note="measured"
          />
          <Kpi
            label="Average model confidence"
            value={pct(d.quality.avgConfidence)}
            sub="The model's own certainty, not measured accuracy"
          />
          <Kpi
            label="Upload to Sales Order"
            value={duration(d.turnaround.medianMinutes)}
            sub={d.turnaround.of === 0 ? 'No Sales Orders yet' : `median over ${d.turnaround.of} PO${d.turnaround.of === 1 ? '' : 's'}`}
            note="measured"
          />
        </div>
      </section>

      <details className="how">
        <summary>How &ldquo;time saved&rdquo; is worked out</summary>
        <p>
          It is an estimate, not a stopwatch reading, and the other figures here are counted from the audit trail. For every PO
          a person approved, the cockpit takes the time to key it into SAP by hand ({d.minutesSaved.assumptions.manualMinutesPerPo} min
          plus {d.minutesSaved.assumptions.manualMinutesPerLine} min per line) and subtracts the time to check it here (
          {d.minutesSaved.assumptions.reviewMinutesPerPo} min plus {d.minutesSaved.assumptions.reviewMinutesPerLine} min per line, and{' '}
          {d.minutesSaved.assumptions.minutesPerCorrection} min for each field corrected). The differences are added up. Replace
          these assumptions with your own team&rsquo;s timings in the <span className="mono">DASHBOARD_*</span> settings and the figure
          follows.
        </p>
      </details>
    </>
  );
}

function Kpi({ label, value, sub, note, tone }: { label: string; value: string; sub?: string; note?: string; tone?: string }) {
  return (
    <div className={`kpi ${tone ?? ''}`}>
      <div className="kpi-l">
        {label}
        {note && <span className="kpi-note">{note}</span>}
      </div>
      <div className="kpi-n tnum">{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}

const dayLabel = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** Two bars a day, drawn as plain SVG so there is nothing to load and nothing to go out of date. */
function Throughput({ daily }: { daily: DashboardData['daily'] }) {
  const W = 720;
  const H = 150;
  const padL = 26;
  const padB = 22;
  const padT = 8;
  const top = Math.max(4, ...daily.map((x) => Math.max(x.uploaded, x.soCreated)));
  const plotH = H - padB - padT;
  const group = (W - padL) / daily.length;
  const barW = Math.max(2, Math.min(14, group / 2 - 2));
  const y = (v: number) => padT + plotH - (v / top) * plotH;
  const totalUp = daily.reduce((n, x) => n + x.uploaded, 0);
  const totalDone = daily.reduce((n, x) => n + x.soCreated, 0);
  const ticks = [0, Math.round(top / 2), top];
  const labelAt = new Set([0, Math.floor((daily.length - 1) / 2), daily.length - 1]);

  return (
    <svg
      className="chart"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={`Over the last ${daily.length} days, ${totalUp} POs uploaded and ${totalDone} Sales Orders created.`}
    >
      {ticks.map((t) => (
        <g key={t}>
          <line x1={padL} x2={W} y1={y(t)} y2={y(t)} className="grid" />
          <text x={padL - 6} y={y(t) + 3} textAnchor="end" className="axis">{t}</text>
        </g>
      ))}
      {daily.map((x, i) => {
        const cx = padL + group * i + group / 2;
        return (
          <g key={x.date}>
            <title>{`${dayLabel(x.date)}: ${x.uploaded} uploaded, ${x.soCreated} Sales Order${x.soCreated === 1 ? '' : 's'} created`}</title>
            <rect x={cx - barW - 1} y={y(x.uploaded)} width={barW} height={H - padB - y(x.uploaded)} className="bar up" />
            <rect x={cx + 1} y={y(x.soCreated)} width={barW} height={H - padB - y(x.soCreated)} className="bar done" />
            {labelAt.has(i) && (
              // The first and last labels hang inward, so neither is cut off by the edge of the chart.
              <text
                x={i === 0 ? padL : i === daily.length - 1 ? W : cx}
                y={H - 6}
                textAnchor={i === 0 ? 'start' : i === daily.length - 1 ? 'end' : 'middle'}
                className="axis"
              >
                {dayLabel(x.date)}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
