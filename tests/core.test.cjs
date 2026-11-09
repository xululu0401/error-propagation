/* 误差传播台 · 核心测试
 * 运行：node --test tests/core.test.cjs
 * 覆盖：解析器、前向自动微分对拍（解析导数 + 中心差分）、一阶误差传播对拍、
 *       和差/积/商/幂的闭式公式对拍、蒙特卡洛对拍与确定性、角点扫描、
 *       目标精度反推、非法与边界输入、输出字段有效性。
 * 说明：参考实现与工程实现对拍只能证明一致；本文件另外用「闭式解析解」和
 *       「中心差分」两条独立路径校验，不用同一个公式自证。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const C = require('../core.js');

// ── 确定性伪随机（测试专用，与核心里的 mulberry32 不是同一个） ──
function lcg(seed) {
  let s = seed >>> 0;
  return function () { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}
function gaussPair(rnd) {
  let u = rnd(); if (u < 1e-12) u = 1e-12;
  const v = rnd(), r = Math.sqrt(-2 * Math.log(u));
  return [r * Math.cos(2 * Math.PI * v), r * Math.sin(2 * Math.PI * v)];
}
function uniform(rnd, lo, hi) { return lo + (hi - lo) * rnd(); }
function pad(x, a, b) { return Math.abs(x) < a ? a : (Math.abs(x) > b ? b : x); }

// 单变量/多变量的独立求值（把表达式交给核心的求值器，但梯度自己算）
function value(expr, names, values) {
  const ast = C.parse(expr, names);
  const env = {};
  names.forEach((nm, i) => { env[nm] = { v: values[i], d: [] }; });
  return C.evalDual(ast, env, 0).v;
}
// 中心差分梯度（独立于自动微分）
function fdGrad(expr, names, values) {
  return names.map((_, i) => {
    const h = 1e-5 * Math.max(1, Math.abs(values[i]));
    const plus = values.slice(); plus[i] += h;
    const minus = values.slice(); minus[i] -= h;
    return (value(expr, names, plus) - value(expr, names, minus)) / (2 * h);
  });
}
function adSolve(expr, vars, extra) {
  return C.solve(Object.assign({ vars, expr, target: { mode: 'abs', value: '' } }, extra || {}));
}
function vrow(name, value, mode, err, unit) { return { name, value: String(value), mode, err: String(err), unit: unit || '' }; }

// ══════════════════════════════════════════════════════════════
// 1. 默认锚点（页面默认场景的所有数字都出自这一次计算）
// ══════════════════════════════════════════════════════════════
test('默认锚点：地板用量 13.83375 m² ± 0.0552349 m²', () => {
  const r = C.solve(C.sample);
  assert.strictEqual(r.expr, '长*宽*(1+损耗率/100)');
  assert.strictEqual(r.varCount, 3);
  assert.strictEqual(r.usedCount, 3);
  assert.ok(Math.abs(r.f - 13.83375) < 1e-12, 'f=' + r.f);
  assert.ok(Math.abs(r.sigmaF - 0.05523489046789177) < 1e-15, 'sigmaF=' + r.sigmaF);
  assert.ok(Math.abs(r.relPct - 0.3992763384323973) < 1e-12);
  assert.strictEqual(r.dominant, '宽');
  assert.ok(Math.abs(r.dominantContributionPct - 65.27238232902701) < 1e-10);
  const byName = Object.fromEntries(r.vars.map(v => [v.name, v]));
  assert.ok(Math.abs(byName['长'].contributionPct - 34.72761767097299) < 1e-10);
  assert.ok(Math.abs(byName['宽'].contributionPct - 65.27238232902701) < 1e-10);
  assert.strictEqual(byName['损耗率'].contributionPct, 0);
  assert.strictEqual(byName['损耗率'].sigma, 0);
  // 敏感度：面积对长、宽都是 1 次齐次，弹性应为 100%
  assert.ok(Math.abs(byName['长'].sensitivityPct - 100) < 1e-12);
  assert.ok(Math.abs(byName['宽'].sensitivityPct - 100) < 1e-12);
  // 角点
  assert.strictEqual(r.corners.count, 8);
  assert.ok(Math.abs(r.corners.min - 4.24 * 3.09 * 1.05) < 1e-12, 'min=' + r.corners.min);
  assert.ok(Math.abs(r.corners.max - 4.26 * 3.11 * 1.05) < 1e-12, 'max=' + r.corners.max);
  assert.strictEqual(r.corners.minVars.length, 3);
  // 目标反推：绝对 ±0.05 → 等比缩小 0.9052249…
  const t = r.target;
  assert.strictEqual(t.feasible, false);
  assert.ok(Math.abs(t.scaleK - 0.05 / r.sigmaF) < 1e-15);
  assert.ok(Math.abs(t.rows[0].requiredSigma - t.scaleK * 0.01) < 1e-18);
  // 只改一个变量
  const p = Object.fromEntries(r.priority.map(x => [x.name, x]));
  assert.strictEqual(p['长'].possible, true);
  assert.strictEqual(p['宽'].possible, true);
  assert.ok(Math.abs(p['宽'].requiredSigma - 0.008505072603699145) < 1e-15);
  assert.ok(Math.abs(p['长'].requiredSigma - 0.006928531370022249) < 1e-15);
  assert.strictEqual(p['损耗率'].possible, false);
  assert.ok(/没有可收紧的空间/.test(p['损耗率'].reason));
  // 最省事的单变量改进应是「宽」（需要收紧的倍数最小）
  assert.ok(p['宽'].improveFactor < p['长'].improveFactor);
  // 蒙特卡洛（固定种子）
  assert.strictEqual(r.mc.samples, 20000);
  assert.strictEqual(r.mc.used, 20000);
  assert.strictEqual(r.mc.nonFinite, 0);
  assert.ok(Math.abs(r.mc.sd - 0.055439903624153734) < 1e-15, 'mc.sd=' + r.mc.sd);
  assert.ok(Math.abs(r.mc.deviationPct) < 5);
  assert.ok(r.mc.min < r.mc.p05 && r.mc.p05 < r.mc.mean && r.mc.mean < r.mc.p95 && r.mc.p95 < r.mc.max);
});

test('默认锚点：建议文本可回溯到同一次计算的数字，且无 undefined/NaN', () => {
  const r = C.solve(C.sample);
  assert.ok(r.advice.length >= 4);
  r.advice.forEach(a => {
    assert.ok(typeof a.text === 'string' && a.text.length > 4);
    assert.ok(!/undefined|NaN|Infinity/.test(a.text), a.text);
  });
  const joined = r.advice.map(a => a.text).join('\n');
  assert.ok(joined.includes('65.27'), '建议里应出现主导贡献 65.27%');
  assert.ok(joined.includes('0.00850507'), '建议里应出现只改「宽」所需的精度');
  assert.ok(joined.includes('0.055235'), '建议里应出现当前一阶不确定度');
  const act = r.advice.find(a => a.level === 'act');
  assert.ok(act && act.apply && act.apply.name === '宽');
});

// ══════════════════════════════════════════════════════════════
// 2. 解析器
// ══════════════════════════════════════════════════════════════
test('解析器：优先级、括号、一元负号、右结合幂', () => {
  const n = ['x', 'y'];
  assert.strictEqual(value('2+3*4', n, [0, 0]), 14);
  assert.strictEqual(value('(2+3)*4', n, [0, 0]), 20);
  assert.strictEqual(value('2-3-4', n, [0, 0]), -5, '减法是左结合');
  assert.strictEqual(value('8/4/2', n, [0, 0]), 1, '除法是左结合');
  assert.strictEqual(value('2^3^2', n, [0, 0]), 512, '幂是右结合');
  assert.strictEqual(value('-2^2', n, [0, 0]), -4, '一元负号低于幂');
  assert.strictEqual(value('2^-1', n, [0, 0]), 0.5);
  assert.strictEqual(value('--3', n, [0, 0]), 3);
  assert.strictEqual(value('+3', n, [0, 0]), 3);
  assert.strictEqual(value('1.5e2', n, [0, 0]), 150);
  assert.strictEqual(value('.5', n, [0, 0]), 0.5);
  assert.strictEqual(value('3', n, [0, 0]), 3);
});

test('解析器：函数与常量', () => {
  const n = ['x'];
  assert.ok(Math.abs(value('sqrt(x)', n, [9]) - 3) < 1e-15);
  assert.ok(Math.abs(value('abs(x)', n, [-4]) - 4) < 1e-15);
  assert.ok(Math.abs(value('ln(x)', n, [Math.E]) - 1) < 1e-15);
  assert.ok(Math.abs(value('log10(x)', n, [1000]) - 3) < 1e-14);
  assert.ok(Math.abs(value('exp(x)', n, [1]) - Math.E) < 1e-15);
  assert.ok(Math.abs(value('sin(pi/2)', n, [0]) - 1) < 1e-15);
  assert.ok(Math.abs(value('cos(0)', n, [0]) - 1) < 1e-15);
  assert.ok(Math.abs(value('tan(0)', n, [0])) < 1e-15);
  assert.ok(Math.abs(value('e', n, [0]) - Math.E) < 1e-15);
  assert.ok(Math.abs(value('pi', n, [0]) - Math.PI) < 1e-15);
});

test('解析器：中文变量名与空白', () => {
  const n = ['长', '宽'];
  assert.strictEqual(value(' 长 * 宽 ', n, [3, 4]), 12);
  assert.strictEqual(value('长+宽', n, [3, 4]), 7);
});

test('解析器：变量名优先于同名常量', () => {
  // 变量表里若有 pi，应优先当变量（normVars 会拒绝，但解析层要一致）
  const n = ['pi'];
  assert.strictEqual(value('pi', n, [7]), 7);
  assert.strictEqual(value('e', n, [7]), Math.E, '不在变量表里的 e 仍是常数');
});

test('解析器：非法公式全部报错且带可读信息', () => {
  const n = ['x'];
  const bad = ['', '   ', 'x+', '*x', '(x', 'x)', 'x**2', 'foo(x)', 'sqrt(x,y)', 'x@2', '2 3', 'x $ y', '()', '(,)', 'sqrt()'];
  bad.forEach(e => {
    assert.throws(() => value(e, n, [1]), undefined, '应报错：' + JSON.stringify(e));
  });
});

// ══════════════════════════════════════════════════════════════
// 3. 自动微分 vs 解析导数（300 组）
// ══════════════════════════════════════════════════════════════
test('自动微分 300 组对拍解析导数', () => {
  const cases = [
    { e: 'x*y', n: ['x', 'y'], d: (v) => [v[1], v[0]], lo: [0.5, 0.5], hi: [9, 9] },
    { e: 'x/y', n: ['x', 'y'], d: (v) => [1 / v[1], -v[0] / (v[1] * v[1])], lo: [0.5, 0.5], hi: [9, 9] },
    { e: 'x^3', n: ['x'], d: (v) => [3 * v[0] * v[0]], lo: [0.5], hi: [9] },
    { e: 'x^2.5', n: ['x'], d: (v) => [2.5 * Math.pow(v[0], 1.5)], lo: [0.5], hi: [9] },
    { e: 'sqrt(x*y)', n: ['x', 'y'], d: (v) => { const s = Math.sqrt(v[0] * v[1]); return [v[1] / (2 * s), v[0] / (2 * s)]; }, lo: [0.5, 0.5], hi: [9, 9] },
    { e: 'ln(x)*exp(y)', n: ['x', 'y'], d: (v) => [Math.exp(v[1]) / v[0], Math.log(v[0]) * Math.exp(v[1])], lo: [0.5, -2], hi: [9, 2] },
    { e: 'sin(x)+cos(y)', n: ['x', 'y'], d: (v) => [Math.cos(v[0]), -Math.sin(v[1])], lo: [-3, -3], hi: [3, 3] },
    { e: 'tan(x)', n: ['x'], d: (v) => [1 / (Math.cos(v[0]) ** 2)], lo: [-1], hi: [1] },
    { e: 'log10(x)', n: ['x'], d: (v) => [1 / (v[0] * Math.LN10)], lo: [0.5], hi: [9] },
    { e: 'abs(x)', n: ['x'], d: (v) => [v[0] > 0 ? 1 : -1], lo: [0.5], hi: [9] },
    { e: 'x*y*z', n: ['x', 'y', 'z'], d: (v) => [v[1] * v[2], v[0] * v[2], v[0] * v[1]], lo: [0.5, 0.5, 0.5], hi: [5, 5, 5] },
    { e: '(x+y)/(x-y)', n: ['x', 'y'], d: (v) => { const t = v[0] - v[1]; return [-2 * v[1] / (t * t), 2 * v[0] / (t * t)]; }, lo: [1, -4], hi: [6, 0.5] },
    { e: 'exp(x*y)', n: ['x', 'y'], d: (v) => { const e = Math.exp(v[0] * v[1]); return [v[1] * e, v[0] * e]; }, lo: [-2, -2], hi: [2, 2] },
    { e: 'sqrt(x^2+y^2)', n: ['x', 'y'], d: (v) => { const r = Math.hypot(v[0], v[1]); return [v[0] / r, v[1] / r]; }, lo: [0.5, 0.5], hi: [9, 9] },
    { e: 'x^y', n: ['x', 'y'], d: (v) => { const p = Math.pow(v[0], v[1]); return [v[1] * p / v[0], p * Math.log(v[0])]; }, lo: [0.5, 0.5], hi: [5, 3] }
  ];
  let n = 0, worst = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const rnd = lcg(seed * 7919 + 13);
    const cs = cases[seed % cases.length];
    const vals = cs.n.map((_, i) => uniform(rnd, cs.lo[i], cs.hi[i]));
    const ast = C.parse(cs.e, cs.n);
    const env = {};
    cs.n.forEach((nm, i) => { const d = cs.n.map((_, k) => (k === i ? 1 : 0)); env[nm] = { v: vals[i], d }; });
    const res = C.evalDual(ast, env, cs.n.length);
    const want = cs.d(vals);
    for (let i = 0; i < want.length; i++) {
      const rel = Math.abs(res.d[i] - want[i]) / Math.max(1e-12, Math.abs(want[i]));
      worst = Math.max(worst, rel);
      assert.ok(rel < 1e-9, `${cs.e} 对 ${cs.n[i]} 的导数 rel=${rel}（得 ${res.d[i]}，期望 ${want[i]}）`);
      n++;
    }
  }
  assert.strictEqual(n, 520, '300 组用例按 15 条表达式轮转，变量个数合计 520 个偏导');
  assert.ok(worst < 1e-9);
});

test('自动微分 200 组对拍中心差分（独立于解析导数）', () => {
  const cases = ['x*y', 'x/y', 'x^3', 'sqrt(x*y)', 'ln(x)*exp(y)', 'sin(x)+cos(y)', '(x+y)/(x-y)', 'x*y*z', 'exp(x*y)', 'sqrt(x^2+y^2)'];
  let n = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const rnd = lcg(seed * 104729 + 7);
    const e = cases[seed % cases.length];
    const names = e.includes('z') ? ['x', 'y', 'z'] : ['x', 'y'];
    const vals = names.map((nm) => nm === 'y' && e.includes('x-y') ? uniform(rnd, 1, 6) : uniform(rnd, 0.6, 6));
    const ast = C.parse(e, names);
    const env = {};
    names.forEach((nm, i) => { const d = names.map((_, k) => (k === i ? 1 : 0)); env[nm] = { v: vals[i], d }; });
    const res = C.evalDual(ast, env, names.length);
    const fd = fdGrad(e, names, vals);
    for (let i = 0; i < names.length; i++) {
      const rel = Math.abs(res.d[i] - fd[i]) / Math.max(1e-8, Math.abs(fd[i]));
      assert.ok(rel < 1e-5, `${e} ∂${names[i]}：AD ${res.d[i]} vs 差分 ${fd[i]}（rel ${rel}）`);
      n++;
    }
  }
  assert.strictEqual(n, 420, '200 组用例按 10 条表达式轮转，变量个数合计 420 个偏导');
});

// ══════════════════════════════════════════════════════════════
// 4. 一阶传播的闭式公式对拍
// ══════════════════════════════════════════════════════════════
test('乘积：σ_f/|f| = √((σx/x)²+(σy/y)²)（300 组）', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const rnd = lcg(seed * 2654435761 + 11);
    const x = uniform(rnd, 0.5, 20), y = uniform(rnd, 0.5, 20);
    const sx = uniform(rnd, 1e-4, 0.05), sy = uniform(rnd, 1e-4, 0.05);
    const r = adSolve('x*y', [vrow('x', x, 'abs', sx), vrow('y', y, 'abs', sy)]);
    const want = Math.sqrt((sx / x) ** 2 + (sy / y) ** 2) * Math.abs(x * y);
    const rel = Math.abs(r.sigmaF - want) / want;
    assert.ok(rel < 1e-12, `σ rel=${rel}`);
  }
});

test('和与差：σ_f = √(σx²+σy²)（各 200 组）', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const rnd = lcg(seed * 40503 + 3);
    const x = uniform(rnd, -20, 20), y = uniform(rnd, -20, 20);
    const sx = uniform(rnd, 1e-4, 0.5), sy = uniform(rnd, 1e-4, 0.5);
    const want = Math.sqrt(sx * sx + sy * sy);
    for (const e of ['x+y', 'x-y']) {
      const r = adSolve(e, [vrow('x', x, 'abs', sx), vrow('y', y, 'abs', sy)]);
      assert.ok(Math.abs(r.sigmaF - want) / want < 1e-12, `${e} σ=${r.sigmaF} want=${want}`);
    }
  }
});

test('商：σ_f/|f| = √((σx/x)²+(σy/y)²)（200 组）', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const rnd = lcg(seed * 22695477 + 5);
    const x = uniform(rnd, 0.5, 20), y = uniform(rnd, 0.5, 20);
    const sx = uniform(rnd, 1e-4, 0.05), sy = uniform(rnd, 1e-4, 0.05);
    const r = adSolve('x/y', [vrow('x', x, 'abs', sx), vrow('y', y, 'abs', sy)]);
    const want = Math.sqrt((sx / x) ** 2 + (sy / y) ** 2) * Math.abs(x / y);
    assert.ok(Math.abs(r.sigmaF - want) / want < 1e-12);
  }
});

test('幂：σ_f/|f| = |n|·σx/|x|（整数与小数指数各 150 组）', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const rnd = lcg(seed * 69069 + 17);
    const x = uniform(rnd, 0.4, 12), sx = uniform(rnd, 1e-4, 0.03);
    const n = seed % 2 ? 3 : 2.5;
    const r = adSolve('x^' + n, [vrow('x', x, 'abs', sx)]);
    const want = Math.abs(n) * sx / x * Math.abs(Math.pow(x, n));
    assert.ok(Math.abs(r.sigmaF - want) / want < 1e-11);
  }
});

test('相对误差模式：σ = |value|·err/100；绝对值模式 σ = err', () => {
  const a = adSolve('x*2', [vrow('x', 50, 'rel', 4)]);
  assert.strictEqual(a.vars[0].sigma, 2);
  assert.strictEqual(a.sigmaF, 4);
  const b = adSolve('x*2', [vrow('x', 50, 'abs', 4)]);
  assert.strictEqual(b.vars[0].sigma, 4);
  assert.strictEqual(b.sigmaF, 8);
  const c = adSolve('x*2', [vrow('x', -50, 'rel', 4)]);
  assert.strictEqual(c.vars[0].sigma, 2, '相对误差按 |value| 折算');
});

test('贡献占比：非零时合计恰为 100%，且与 ∂f/∂x·σ 的平方成正比（200 组）', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const rnd = lcg(seed * 1103515245 + 12345);
    const vs = ['x', 'y', 'z'].map(() => ({ v: uniform(rnd, 0.5, 10), s: uniform(rnd, 1e-3, 0.2) }));
    const r = adSolve('x*y+z', ['x', 'y', 'z'].map((nm, i) => vrow(nm, vs[i].v, 'abs', vs[i].s)));
    const sum = r.vars.reduce((a, v) => a + v.contributionPct, 0);
    assert.ok(Math.abs(sum - 100) < 1e-9, 'sum=' + sum);
    r.vars.forEach(v => assert.ok(v.contributionPct >= 0 && v.contributionPct <= 100));
    // 与手算的平方项一致
    const terms = vs.map((o, i) => {
      const g = [vs[1].v, vs[0].v, 1][i];
      return (g * o.s) ** 2;
    });
    const tot = terms.reduce((a, b) => a + b, 0);
    r.vars.forEach((v, i) => assert.ok(Math.abs(v.contributionPct - terms[i] / tot * 100) < 1e-9));
  }
});

test('一阶传播与中心差分梯度对拍（200 组）', () => {
  const cases = ['x*y', 'x/y', 'sqrt(x*y)', 'ln(x)*exp(y)', '(x+y)/(x-y)', 'x*y*z'];
  for (let seed = 1; seed <= 200; seed++) {
    const rnd = lcg(seed * 214013 + 2531011);
    const e = cases[seed % cases.length];
    const names = e.includes('z') ? ['x', 'y', 'z'] : ['x', 'y'];
    const vals = names.map(() => uniform(rnd, 0.7, 8));
    const sig = names.map(() => uniform(rnd, 1e-4, 0.02));
    const r = adSolve(e, names.map((nm, i) => vrow(nm, vals[i], 'abs', sig[i])));
    const g = fdGrad(e, names, vals);
    const want = Math.sqrt(g.reduce((a, gi, i) => a + (gi * sig[i]) ** 2, 0));
    assert.ok(Math.abs(r.sigmaF - want) / want < 1e-5, `${e}: ${r.sigmaF} vs ${want}`);
  }
});

// ══════════════════════════════════════════════════════════════
// 5. 蒙特卡洛
// ══════════════════════════════════════════════════════════════
test('蒙特卡洛：固定种子可复现', () => {
  const a = C.solve(C.sample), b = C.solve(C.sample);
  assert.strictEqual(a.mc.sd, b.mc.sd);
  assert.strictEqual(a.mc.mean, b.mc.mean);
  assert.strictEqual(a.mc.min, b.mc.min);
});

test('蒙特卡洛：与一阶传播一致（默认样例）', () => {
  const r = C.solve(C.sample);
  assert.ok(Math.abs(r.mc.deviationPct) < 5, 'dev=' + r.mc.deviationPct);
  assert.ok(Math.abs(r.mc.biasPct) < 1);
});

test('蒙特卡洛：与独立实现（不同随机数发生器）对拍（120 组）', () => {
  const cases = [
    { e: 'x*y', n: ['x', 'y'] },
    { e: 'x+y', n: ['x', 'y'] },
    { e: 'x/y', n: ['x', 'y'] },
    { e: 'sqrt(x*y)', n: ['x', 'y'] },
    { e: 'x*y*z', n: ['x', 'y', 'z'] }
  ];
  const N = 60000;
  for (let seed = 1; seed <= 120; seed++) {
    const rnd = lcg(seed * 97 + 5);
    const cs = cases[seed % cases.length];
    const vals = cs.n.map(() => uniform(rnd, 1, 8));
    const sig = cs.n.map(() => uniform(rnd, 0.005, 0.05));
    const r = adSolve(cs.e, cs.n.map((nm, i) => vrow(nm, vals[i], 'abs', sig[i])));
    // 独立蒙特卡洛
    const r2 = lcg(seed * 1000003 + 999);
    let sum = 0, sum2 = 0, cnt = 0;
    for (let k = 0; k < N; k++) {
      const sample = vals.map((v, i) => v + sig[i] * gaussPair(r2)[0]);
      const fv = value(cs.e, cs.n, sample);
      sum += fv; sum2 += fv * fv; cnt++;
    }
    const mean = sum / cnt;
    const sd = Math.sqrt((sum2 - cnt * mean * mean) / (cnt - 1));
    const rel = Math.abs(sd - r.mc.sd) / sd;
    assert.ok(rel < 0.05, `${cs.e} seed=${seed}: 核心 ${r.mc.sd} vs 独立 ${sd}（rel ${rel}）`);
    const relLin = Math.abs(r.sigmaF - sd) / sd;
    assert.ok(relLin < 0.05, `${cs.e} 一阶 ${r.sigmaF} vs 独立 MC ${sd}`);
  }
});

test('蒙特卡洛：样本数可选，非法值回落默认', () => {
  assert.strictEqual(C.solve(Object.assign({}, C.sample, { mcSamples: 5000 })).mc.samples, 5000);
  assert.strictEqual(C.solve(Object.assign({}, C.sample, { mcSamples: 50000 })).mc.samples, 50000);
  assert.strictEqual(C.solve(Object.assign({}, C.sample, { mcSamples: 777 })).mc.samples, 20000);
  assert.strictEqual(C.solve(Object.assign({}, C.sample, { mcSamples: 'abc' })).mc.samples, 20000);
});

// ══════════════════════════════════════════════════════════════
// 6. 角点扫描
// ══════════════════════════════════════════════════════════════
test('角点扫描：个数为 2ⁿ，单调式子的极值与手算一致', () => {
  const r1 = adSolve('x+y', [vrow('x', 3, 'abs', 0.5), vrow('y', 4, 'abs', 0.25)]);
  assert.strictEqual(r1.corners.count, 4);
  assert.ok(Math.abs(r1.corners.min - (3 - 0.5 + 4 - 0.25)) < 1e-12);
  assert.ok(Math.abs(r1.corners.max - (3 + 0.5 + 4 + 0.25)) < 1e-12);
  const r2 = adSolve('x*y', [vrow('x', 5, 'abs', 0.1), vrow('y', 8, 'abs', 0.2)]);
  assert.ok(Math.abs(r2.corners.min - (4.9 * 7.8)) < 1e-12);
  assert.ok(Math.abs(r2.corners.max - (5.1 * 8.2)) < 1e-12);
  const r3 = adSolve('x*y*z', [vrow('x', 2, 'abs', 0.1), vrow('y', 3, 'abs', 0.1), vrow('z', 4, 'abs', 0.1)]);
  assert.strictEqual(r3.corners.count, 8);
  const r4 = adSolve('x', [vrow('x', 1, 'abs', 0.1)]);
  assert.strictEqual(r4.corners.count, 2);
  assert.ok(Math.abs(r4.corners.min - 0.9) < 1e-12 && Math.abs(r4.corners.max - 1.1) < 1e-12);
});

test('角点扫描：记录取到极值时的各变量取值', () => {
  const r = adSolve('x*y', [vrow('x', 5, 'abs', 1), vrow('y', 8, 'abs', 1)]);
  assert.strictEqual(r.corners.minVars.length, 2);
  assert.ok(r.corners.minVars.includes('x=4'));
  assert.ok(r.corners.minVars.includes('y=7'));
  assert.ok(r.corners.maxVars.includes('x=6'));
  assert.ok(r.corners.maxVars.includes('y=9'));
});

test('角点范围包含一阶 ±1σ 区间（默认样例）', () => {
  const r = C.solve(C.sample);
  assert.ok(r.corners.min <= r.f - r.sigmaF + 1e-12);
  assert.ok(r.corners.max >= r.f + r.sigmaF - 1e-12);
});

// ══════════════════════════════════════════════════════════════
// 7. 目标精度反推
// ══════════════════════════════════════════════════════════════
test('目标反推（绝对）：requiredSigma = k·σᵢ，k = target/σ_f', () => {
  const r = adSolve('x*y', [vrow('x', 5, 'abs', 0.1), vrow('y', 8, 'abs', 0.2)],
    { target: { mode: 'abs', value: '0.5' } });
  const k = 0.5 / r.sigmaF;
  assert.ok(Math.abs(r.target.scaleK - k) < 1e-15);
  r.target.rows.forEach((row, i) => {
    assert.ok(Math.abs(row.requiredSigma - k * r.vars[i].sigma) < 1e-15);
  });
  assert.strictEqual(r.target.feasible, r.sigmaF <= 0.5);
});

test('目标反推（相对）：sigmaTarget = |f|·p/100', () => {
  const r = adSolve('x*y', [vrow('x', 5, 'abs', 0.1), vrow('y', 8, 'abs', 0.2)],
    { target: { mode: 'rel', value: '2' } });
  assert.ok(Math.abs(r.target.sigmaTarget - Math.abs(r.f) * 0.02) < 1e-15);
});

test('单变量改进：解 σ_target² − Σ_{j≠i}(∂f_j σ_j)² 并与实际重算互证', () => {
  const r = adSolve('x*y*z', [vrow('x', 2, 'abs', 0.02), vrow('y', 3, 'abs', 0.03), vrow('z', 4, 'abs', 0.01)],
    { target: { mode: 'abs', value: '0.2' } });
  const p = Object.fromEntries(r.priority.map(x => [x.name, x]));
  ['x', 'y', 'z'].forEach((nm, i) => {
    if (p[nm].possible !== true) return;
    // 把该变量的误差真的改成反推值，重算后应当命中目标（误差 ≤ target 且接近）
    const vars = r.vars.map((v, k) => vrow(v.name, v.value, v.mode, k === i ? p[nm].requiredErr : v.err, v.unit));
    const r2 = C.solve({ vars, expr: 'x*y*z', target: { mode: 'abs', value: '0.2' } });
    assert.ok(r2.sigmaF <= 0.2 * (1 + 1e-9), `${nm} 重算 σ=${r2.sigmaF} 应 ≤ 0.2`);
    assert.ok(r2.sigmaF > 0.2 * 0.9, `${nm} 重算 σ=${r2.sigmaF} 不应远小于目标（反推应恰好贴住）`);
  });
});

test('单变量改进：其余项已超目标时判为不可能', () => {
  const r = adSolve('x+y', [vrow('x', 1, 'abs', 1), vrow('y', 1, 'abs', 1)],
    { target: { mode: 'abs', value: '0.5' } });
  r.priority.forEach(p => {
    assert.strictEqual(p.possible, false);
    assert.ok(/必须同时改多个/.test(p.reason));
  });
});

test('目标已达标的判定与余量', () => {
  const r = adSolve('x*2', [vrow('x', 10, 'abs', 0.1)], { target: { mode: 'abs', value: '1' } });
  assert.strictEqual(r.target.feasible, true);
  const adv = r.advice.map(a => a.text).join('\n');
  assert.ok(/已经满足目标/.test(adv));
});

test('目标留空或 0：不做反推，提示填目标', () => {
  const a = adSolve('x*2', [vrow('x', 10, 'abs', 0.1)]);
  assert.strictEqual(a.target, null);
  assert.ok(a.priority.every(p => p.possible === null));
  assert.ok(/填一个目标精度/.test(a.advice.map(x => x.text).join('\n')));
  const b = adSolve('x*2', [vrow('x', 10, 'abs', 0.1)], { target: { mode: 'abs', value: '0' } });
  assert.strictEqual(b.target, null);
});

// ══════════════════════════════════════════════════════════════
// 8. 边界与结构
// ══════════════════════════════════════════════════════════════
test('单变量、8 变量（256 个角点）', () => {
  const one = adSolve('x^2', [vrow('x', 3, 'abs', 0.1)]);
  assert.strictEqual(one.varCount, 1);
  assert.ok(Math.abs(one.sigmaF - 0.6) < 1e-12);
  const names = ['a', 'b', 'c', 'd', 'p', 'q', 'r', 's'];   // 避开内置常数 e
  const vars = names.map((nm, i) => vrow(nm, i + 1, 'abs', 0.01));
  const r = adSolve(names.join('*'), vars);
  assert.strictEqual(r.varCount, 8);
  assert.strictEqual(r.corners.count, 256);
  assert.ok(r.corners.min < r.f && r.corners.max > r.f);
  assert.ok(Math.abs(r.vars.reduce((a, v) => a + v.contributionPct, 0) - 100) < 1e-9);
});

test('未使用的变量：不参与、被点名、改进优先级为不可能', () => {
  const r = adSolve('x*2', [vrow('x', 3, 'abs', 0.1), vrow('没用上', 9, 'abs', 1)],
    { target: { mode: 'abs', value: '1' } });
  const u = r.vars.find(v => v.name === '没用上');
  assert.strictEqual(u.used, false);
  assert.strictEqual(u.contributionPct, 0);
  assert.strictEqual(r.usedCount, 1);
  assert.ok(/没有出现在公式里/.test(r.advice.map(a => a.text).join('\n')));
  const p = r.priority.find(x => x.name === '没用上');
  assert.strictEqual(p.possible, false);
});

test('全部误差为 0：σ_f = 0，给出专门提示，不出现 NaN', () => {
  const r = adSolve('x*y', [vrow('x', 3, 'abs', 0), vrow('y', 4, 'abs', 0)]);
  assert.strictEqual(r.sigmaF, 0);
  assert.strictEqual(r.relPct, 0);
  assert.strictEqual(r.dominant, null);
  assert.ok(r.vars.every(v => v.contributionPct === 0));
  assert.ok(/所有变量的误差都是 0/.test(r.advice.map(a => a.text).join('\n')));
  assert.strictEqual(r.mc.sd, 0);
  assert.ok(!/NaN|undefined/.test(JSON.stringify(r)));
});

test('f = 0：relPct 与敏感度为 null，仍给出角点与蒙特卡洛', () => {
  const r = adSolve('x-5', [vrow('x', 5, 'abs', 0.1)]);
  assert.strictEqual(r.f, 0);
  assert.ok(Math.abs(r.sigmaF - 0.1) < 1e-12, '结果为 0 不影响导数与传播');
  assert.strictEqual(r.relPct, null);
  assert.strictEqual(r.vars[0].sensitivityPct, null);
  assert.ok(Math.abs(r.corners.min - (-0.1)) < 1e-12, 'corners.min=' + r.corners.min);
  assert.ok(Math.abs(r.corners.max - 0.1) < 1e-12, 'corners.max=' + r.corners.max);
  assert.ok(r.mc.sd !== undefined);
  assert.ok(!/NaN/.test(JSON.stringify(r)));
});

test('变量数值为 0：不炸，贡献按 0 处理', () => {
  const r = adSolve('x*y', [vrow('x', 0, 'abs', 0.1), vrow('y', 4, 'abs', 0.2)]);
  assert.strictEqual(r.f, 0);
  // ∂(xy)/∂x = y = 4，∂(xy)/∂y = x = 0；x=0 只让 y 这一项归零，x 那一项仍是 4×0.1
  assert.ok(Math.abs(r.sigmaF - 0.4) < 1e-12, 'σ 应等于 |∂f/∂x|·σx = 4×0.1');
  assert.strictEqual(r.vars[0].contributionPct, 100);
  assert.strictEqual(r.vars[1].contributionPct, 0);
  const r2 = adSolve('x+y', [vrow('x', 0, 'rel', 5), vrow('y', 2, 'abs', 0.1)]);
  assert.strictEqual(r2.vars[0].sigma, 0, '相对误差在 0 值上折算成 0');
});

test('负数与负结果', () => {
  const r = adSolve('x-y', [vrow('x', 1, 'abs', 0.1), vrow('y', 5, 'abs', 0.2)]);
  assert.ok(Math.abs(r.f - (-4)) < 1e-12);
  assert.ok(Math.abs(r.sigmaF - Math.sqrt(0.01 + 0.04)) < 1e-12);
  assert.ok(Math.abs(r.relPct - r.sigmaF / 4 * 100) < 1e-12, '相对不确定度用 |f|');
  const t = adSolve('x-y', [vrow('x', 1, 'abs', 0.1), vrow('y', 5, 'abs', 0.2)], { target: { mode: 'rel', value: '1' } });
  assert.ok(Math.abs(t.target.sigmaTarget - 0.04) < 1e-12);
});

test('结果对象字段完整且数值有效（递归扫描）', () => {
  const r = C.solve(C.sample);
  const okNull = new Set(['sensitivityPct', 'requiredSigma', 'requiredErr', 'requiredLabel', 'improveFactor', 'relPct', 'dominant', 'dominantContributionPct', 'target', 'tightenPct', 'deviationPct', 'biasPct', 'mean', 'sd', 'min', 'max', 'p05', 'p95']);
  (function walk(o, path) {
    if (o === null) return;
    if (o === undefined) throw new Error('undefined at ' + path);
    if (typeof o === 'number') {
      if (!isFinite(o)) throw new Error('非有限数 at ' + path + ' = ' + o);
      return;
    }
    if (typeof o !== 'object') return;
    Object.keys(o).forEach(k => walk(o[k], path + '.' + k));
  })(r, 'root');
  assert.ok(Array.isArray(r.warnings) && r.warnings.length >= 5);
  assert.ok(Array.isArray(r.advice) && r.advice.length >= 3);
  assert.strictEqual(typeof r.mc.seed, 'number');
});

test('同一输入两次求解结果逐字节一致（确定性）', () => {
  const a = JSON.stringify(C.solve(C.sample));
  const b = JSON.stringify(C.solve(C.sample));
  assert.strictEqual(a, b);
});

// ══════════════════════════════════════════════════════════════
// 9. 非法与越界输入
// ══════════════════════════════════════════════════════════════
test('非法输入：全部抛出带中文说明的错误', () => {
  const bad = [
    [{ vars: [], expr: 'x' }, /至少要有一个变量/],
    [{ vars: new Array(9).fill(0).map((_, i) => vrow('v' + i, 1, 'abs', 0.1)), expr: 'v0' }, /变量最多 8 个/],
    [{ vars: [vrow('', 1, 'abs', 0.1)], expr: '' }, /不能为空|请先写一个公式/],
    [{ vars: [vrow('这个变量的名字实在是太长了', 1, 'abs', 0.1)], expr: 'x' }, /超过 12 个字符/],
    [{ vars: [vrow('2x', 1, 'abs', 0.1)], expr: '2x' }, /只能用中文、字母、数字和下划线/],
    [{ vars: [vrow('a b', 1, 'abs', 0.1)], expr: 'a' }, /只能用中文、字母、数字和下划线/],
    [{ vars: [vrow('x', 1, 'abs', 0.1), vrow('x', 2, 'abs', 0.1)], expr: 'x' }, /重复/],
    [{ vars: [vrow('sqrt', 1, 'abs', 0.1)], expr: 'sqrt' }, /函数名/],
    [{ vars: [vrow('pi', 1, 'abs', 0.1)], expr: 'pi' }, /内置常数/],
    [{ vars: [vrow('x', 'abc', 'abs', 0.1)], expr: 'x' }, /不是有效数字/],
    [{ vars: [vrow('x', '', 'abs', 0.1)], expr: 'x' }, /不能为空/],
    [{ vars: [vrow('x', '1e400', 'abs', 0.1)], expr: 'x' }, /可计算范围|超出上限/],
    [{ vars: [vrow('x', 1, 'abs', -1)], expr: 'x' }, /不能是负数/],
    [{ vars: [vrow('x', 1, 'abs', 'abc')], expr: 'x' }, /不是有效数字/],
    [{ vars: [vrow('x', 1, 'rel', 20000)], expr: 'x' }, /不能超过 10000/],
    [{ vars: [vrow('x', 1, 'abs', 0.1)], expr: '' }, /请先写一个公式/],
    [{ vars: [vrow('x', 1, 'abs', 0.1)], expr: '   ' }, /请先写一个公式/],
    [{ vars: [vrow('x', 1, 'abs', 0.1)], expr: 'x'.repeat(301) }, /最多 300 个字符/],
    [{ vars: [vrow('x', 1, 'abs', 0.1)], expr: 'y*2' }, /不在变量表里/],
    [{ vars: [vrow('x', 1, 'abs', 0.1)], expr: '(x' }, /右括号/],
    [{ vars: [vrow('x', 1, 'abs', 0.1)], expr: 'x)' }, /多余内容/],
    [{ vars: [vrow('x', 1, 'abs', 0.1)], expr: 'x+' }, /断了|不完整/],
    [{ vars: [vrow('x', 1, 'abs', 0.1)], expr: 'x@1' }, /不认识的字符/],
    [{ vars: [vrow('x', 1, 'abs', 0.1)], expr: 'foo(x)' }, /不支持的函数/],
    [{ vars: [vrow('x', 1, 'abs', 0.1)], expr: 'sqrt(x,1)' }, /只接受 1 个参数/],
    [{ vars: [vrow('x', 1, 'abs', 0.1)], expr: 'x/0' }, /除以 0/],
    [{ vars: [vrow('x', 0, 'abs', 0.1)], expr: '1/x' }, /除以 0/],
    [{ vars: [vrow('x', -1, 'abs', 0.1)], expr: 'sqrt(x)' }, /不能是负数/],
    [{ vars: [vrow('x', 0, 'abs', 0.1)], expr: 'sqrt(x)' }, /导数为无穷/],
    [{ vars: [vrow('x', 0, 'abs', 0.1)], expr: 'ln(x)' }, /必须大于 0/],
    [{ vars: [vrow('x', -2, 'abs', 0.1)], expr: 'ln(x)' }, /必须大于 0/],
    [{ vars: [vrow('x', 0, 'abs', 0.1)], expr: 'log10(x)' }, /必须大于 0/],
    [{ vars: [vrow('x', 0, 'abs', 0.1)], expr: 'abs(x)' }, /没有定义/],
    [{ vars: [vrow('x', Math.PI / 2, 'abs', 0.1)], expr: 'tan(x)' }, /没有定义/],
    [{ vars: [vrow('x', -8, 'abs', 0.1)], expr: 'x^0.5' }, /没有实数结果/],
    [{ vars: [vrow('x', 0, 'abs', 0.1)], expr: 'x^0.5' }, /导数.*没有定义|没有定义/],
    [{ vars: [vrow('x', -2, 'abs', 0.1), vrow('y', 0.5, 'abs', 0.1)], expr: 'x^y' }, /底数必须大于 0/],
    [{ vars: [vrow('x', 1, 'abs', 0.1)], expr: 'x^100000000' }, /溢出|没有实数结果/],
    [{ vars: [vrow('x', 800, 'abs', 0.1)], expr: 'exp(x)' }, /溢出/],
    [{ vars: [vrow('x', 1, 'abs', 0.1)], expr: 'x', target: { mode: 'abs', value: '-1' } }, /不能是负数/],
    [{ vars: [vrow('x', 1, 'abs', 0.1)], expr: 'x', target: { mode: 'abs', value: 'abc' } }, /不是有效数字/]
  ];
  bad.forEach(([input, re], idx) => {
    assert.throws(() => C.solve(input), (e) => {
      const msg = e.userMessage || e.message;
      assert.ok(re.test(msg), `第 ${idx + 1} 条：期望匹配 ${re}，实际「${msg}」`);
      return true;
    }, `第 ${idx + 1} 条应报错`);
  });
  assert.ok(bad.length >= 29, '非法输入用例数 ' + bad.length);
});

test('错误对象带 userMessage，便于界面直接展示', () => {
  try { C.solve({ vars: [], expr: 'x' }); assert.fail('应报错'); }
  catch (e) { assert.strictEqual(typeof e.userMessage, 'string'); assert.ok(e.userMessage.length > 2); }
});

test('字符串数值按界面传来的原样接受（含前后空格）', () => {
  const r = C.solve({ vars: [{ name: 'x', value: ' 3.5 ', mode: 'abs', err: ' 0.1 ' }], expr: 'x*2' });
  assert.strictEqual(r.f, 7);
  assert.ok(Math.abs(r.sigmaF - 0.2) < 1e-12);
});

// ══════════════════════════════════════════════════════════════
// 10. 格式化与工具
// ══════════════════════════════════════════════════════════════
test('fmt：有效数字、科学计数法、零与负数', () => {
  assert.strictEqual(C.fmt(0), '0');
  assert.strictEqual(C.fmt(-0), '0');
  assert.strictEqual(C.fmt(13.83375, 6), '13.8338');
  assert.strictEqual(C.fmt(0.05523489, 3), '0.0552');
  assert.strictEqual(C.fmt(-4, 6), '-4');
  assert.strictEqual(C.fmt(1e9, 6), '1.00000e+9');
  assert.strictEqual(C.fmt(1e-9, 3), '1.00e-9');
  assert.strictEqual(C.fmt(NaN), '—');
  assert.strictEqual(C.fmt(Infinity), '—');
});

test('quantile：端点与中位', () => {
  const s = [1, 2, 3, 4, 5];
  assert.strictEqual(C.quantile(s, 0), 1);
  assert.strictEqual(C.quantile(s, 1), 5);
  assert.strictEqual(C.quantile(s, 0.5), 3);
  assert.strictEqual(C.quantile(s, 0.25), 2);
  assert.strictEqual(C.quantile([], 0.5), null);
});

test('collectVars 去重并保序', () => {
  const ast = C.parse('b*a+b', ['a', 'b']);
  assert.deepStrictEqual(C.collectVars(ast, []), ['b', 'a']);
});

test('isConstNode：常数折叠判断', () => {
  assert.strictEqual(C.isConstNode(C.parse('2*3+1', [])), true);
  assert.strictEqual(C.isConstNode(C.parse('sqrt(2)', [])), true);
  assert.strictEqual(C.isConstNode(C.parse('x*2', ['x'])), false);
  assert.strictEqual(C.isConstNode(C.parse('2^x', ['x'])), false);
});
