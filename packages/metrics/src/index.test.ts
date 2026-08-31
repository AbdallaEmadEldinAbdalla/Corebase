import { describe, it, expect } from 'vitest';
import { Registry, Counter, Gauge, Histogram } from './index.ts';

const lines = (text: string) => text.trim().split('\n');

describe('Counter', () => {
  it('exposes help, type and value', async () => {
    const r = new Registry();
    const c = r.register(new Counter({ name: 'jobs_total', help: 'Jobs run.' }));
    c.inc();
    c.inc({}, 4);
    expect(lines(await r.metricsText())).toEqual([
      '# HELP jobs_total Jobs run.',
      '# TYPE jobs_total counter',
      'jobs_total 5',
    ]);
  });

  it('keeps one series per label combination', async () => {
    const r = new Registry();
    const c = r.register(new Counter({
      name: 'jobs_total', help: 'h', labelNames: ['job_type', 'outcome'] }));
    c.inc({ job_type: 'provision_project', outcome: 'succeeded' });
    c.inc({ job_type: 'provision_project', outcome: 'succeeded' });
    c.inc({ job_type: 'provision_project', outcome: 'failed' });
    const text = await r.metricsText();
    expect(text).toContain('jobs_total{job_type="provision_project",outcome="succeeded"} 2');
    expect(text).toContain('jobs_total{job_type="provision_project",outcome="failed"} 1');
  });

  it('refuses to decrease', () => {
    const c = new Counter({ name: 'c_total', help: 'h' });
    expect(() => c.inc({}, -1)).toThrow(/cannot decrease/);
  });

  it('refuses an inconsistent label set', () => {
    // Prometheus tolerates this on the wire; PromQL and humans do not.
    const c = new Counter({ name: 'c_total', help: 'h', labelNames: ['a', 'b'] });
    expect(() => c.inc({ a: '1' })).toThrow(/expects labels \[a, b\]/);
    expect(() => c.inc({ a: '1', b: '2', c: '3' })).toThrow(/expects labels/);
  });
});

describe('Gauge', () => {
  it('sets and overwrites', async () => {
    const r = new Registry();
    const g = r.register(new Gauge({ name: 'ratio', help: 'h', labelNames: ['node'] }));
    g.set({ node: 'data-1' }, 0.42);
    g.set({ node: 'data-1' }, 0.51);
    expect(await r.metricsText()).toContain('ratio{node="data-1"} 0.51');
  });

  it('can forget a series, because a gauge for something gone is a lie', async () => {
    const r = new Registry();
    const g = r.register(new Gauge({ name: 'ratio', help: 'h', labelNames: ['node'] }));
    g.set({ node: 'gone' }, 1);
    g.remove({ node: 'gone' });
    expect(await r.metricsText()).not.toContain('gone');
  });
});

describe('Histogram', () => {
  it('exposes cumulative buckets, +Inf, sum and count', async () => {
    const r = new Registry();
    const h = r.register(new Histogram({
      name: 'job_seconds', help: 'h', buckets: [1, 5, 10] }));
    h.observe(0.5);
    h.observe(3);
    h.observe(30);
    const text = await r.metricsText();
    // Cumulative: le="5" carries the 0.5 and the 3, not just the 3. Getting this
    // wrong makes histogram_quantile() return plausible nonsense.
    expect(text).toContain('job_seconds_bucket{le="1"} 1');
    expect(text).toContain('job_seconds_bucket{le="5"} 2');
    expect(text).toContain('job_seconds_bucket{le="10"} 2');
    expect(text).toContain('job_seconds_bucket{le="+Inf"} 3');
    expect(text).toContain('job_seconds_sum 33.5');
    expect(text).toContain('job_seconds_count 3');
  });

  it('+Inf always equals _count', async () => {
    const r = new Registry();
    const h = r.register(new Histogram({ name: 'h_seconds', help: 'h', buckets: [0.001] }));
    for (const v of [5, 10, 100, 0.0005]) h.observe(v);
    const text = await r.metricsText();
    const inf = /h_seconds_bucket\{le="\+Inf"\} (\d+)/.exec(text)![1];
    const count = /h_seconds_count (\d+)/.exec(text)![1];
    expect(inf).toBe(count);
    expect(inf).toBe('4');
  });

  it('keeps buckets per label combination', async () => {
    const r = new Registry();
    const h = r.register(new Histogram({
      name: 'job_seconds', help: 'h', labelNames: ['job_type'], buckets: [1] }));
    h.observe({ job_type: 'a' }, 0.5);
    h.observe({ job_type: 'b' }, 2);
    const text = await r.metricsText();
    expect(text).toContain('job_seconds_bucket{job_type="a",le="1"} 1');
    expect(text).toContain('job_seconds_bucket{job_type="b",le="1"} 0');
    expect(text).toContain('job_seconds_bucket{job_type="b",le="+Inf"} 1');
  });

  it('refuses unsorted buckets and a reserved label', () => {
    expect(() => new Histogram({ name: 'h', help: 'h', buckets: [5, 1] })).toThrow(/must ascend/);
    expect(() => new Histogram({ name: 'h', help: 'h', buckets: [] })).toThrow(/at least one bucket/);
    // `le` belongs to the histogram; a user label of that name silently corrupts
    // every quantile query.
    expect(() => new Histogram({ name: 'h', help: 'h', buckets: [1], labelNames: ['le'] }))
      .toThrow(/cannot use "le"/);
  });

  it('times a promise in seconds', async () => {
    const r = new Registry();
    const h = r.register(new Histogram({ name: 't_seconds', help: 'h', buckets: [10] }));
    await h.time({}, async () => new Promise((res) => setTimeout(res, 30)));
    const text = await r.metricsText();
    expect(text).toContain('t_seconds_count 1');
    expect(text).toContain('t_seconds_bucket{le="10"} 1');
  });

  it('observes a failing call before rethrowing', async () => {
    const r = new Registry();
    const h = r.register(new Histogram({ name: 'f_seconds', help: 'h', buckets: [10] }));
    await expect(h.time({}, async () => { throw new Error('nope'); })).rejects.toThrow('nope');
    // A histogram that only records successes hides exactly the latency you are
    // looking for during an incident.
    expect(await r.metricsText()).toContain('f_seconds_count 1');
  });
});

describe('Registry', () => {
  it('refuses a duplicate metric name', () => {
    const r = new Registry();
    r.register(new Counter({ name: 'dup_total', help: 'h' }));
    expect(() => r.register(new Counter({ name: 'dup_total', help: 'h' }))).toThrow(/already registered/);
  });

  it('runs collectors before each scrape', async () => {
    const r = new Registry();
    const g = r.register(new Gauge({ name: 'live', help: 'h' }));
    let n = 0;
    r.addCollector(() => { g.set(++n); });
    expect(await r.metricsText()).toContain('live 1');
    expect(await r.metricsText()).toContain('live 2');
  });

  it('escapes label values', async () => {
    const r = new Registry();
    const c = r.register(new Counter({ name: 'e_total', help: 'h', labelNames: ['msg'] }));
    c.inc({ msg: 'say "hi"\\nand\nnewline' });
    const text = await r.metricsText();
    expect(text).toContain('\\"hi\\"');
    expect(text).not.toMatch(/msg="[^"]*\n/);
  });

  it('rejects an invalid metric name', () => {
    expect(() => new Counter({ name: '1bad', help: 'h' })).toThrow(/not a valid Prometheus metric name/);
    expect(() => new Counter({ name: 'has-dash', help: 'h' })).toThrow(/not a valid/);
  });

  it('ends with a newline, as the exposition format requires', async () => {
    const r = new Registry();
    r.register(new Counter({ name: 'x_total', help: 'h' })).inc();
    expect(await r.metricsText()).toMatch(/\n$/);
  });
});
