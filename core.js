/* 误差传播台 · core.js
 * 公式解析（递归下降）→ 前向自动微分（对偶数）→ 一阶误差传播 → 贡献分解
 * → 目标精度反推 → 角点扫描 → 固定种子蒙特卡洛对照。
 * 纯计算、无 DOM、无网络；浏览器挂 window.AppCore，Node 下 module.exports。
 */
(function (global) {
  'use strict';

  var LIMITS = {
    MIN_VARS: 1, MAX_VARS: 8,
    MAX_NAME: 12,
    MAX_EXPR: 300,
    MAX_ABS_VALUE: 1e9,
    MAX_ABS_ERR: 1e9,
    MAX_REL_ERR: 10000,          // 相对误差最大 10000 %
    MC_OPTIONS: [5000, 20000, 50000],
    MC_DEFAULT: 20000,
    MC_SEED: 20261109
  };

  var FUNC_NAMES = ['sqrt', 'abs', 'ln', 'log10', 'exp', 'sin', 'cos', 'tan'];
  var CONSTS = { pi: Math.PI, e: Math.E };
  var IDENT_RE = /^[A-Za-z_\u4e00-\u9fa5][A-Za-z0-9_\u4e00-\u9fa5]*$/;
  var NUM_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

  function err(msg) { var e = new Error(msg); e.userMessage = msg; return e; }

  // ── 数值解析与格式化 ────────────────────────────────────────
  function numStrict(v, label) {
    var x;
    if (typeof v === 'number') {
      x = v;
    } else {
      var s = String(v === null || v === undefined ? '' : v).trim();
      if (!s) throw err(label + '不能为空');
      if (!NUM_RE.test(s)) throw err(label + '不是有效数字：' + s);
      x = Number(s);
    }
    if (!isFinite(x)) throw err(label + '超出了可计算范围');
    if (Math.abs(x) > LIMITS.MAX_ABS_VALUE) throw err(label + '超出上限（绝对值最大 ' + LIMITS.MAX_ABS_VALUE + '）');
    return x;
  }

  /** 按有效数字格式化；数量级过大或过小时用科学计数法。 */
  function fmt(v, sig) {
    sig = sig || 6;
    if (typeof v !== 'number' || !isFinite(v)) return '—';
    if (v === 0) return '0';
    var a = Math.abs(v);
    if (a >= 1e-4 && a < 1e7) {
      var d = sig - 1 - Math.floor(Math.log10(a));
      if (d < 0) d = 0;
      if (d > 12) d = 12;
      var s = v.toFixed(d);
      if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
      return s === '-0' ? '0' : s;
    }
    var m = v.toExponential(Math.max(0, sig - 1));
    return m;
  }

  // ── 词法与语法 ──────────────────────────────────────────────
  function tokenize(src) {
    var t = [], i = 0, n = src.length, m;
    while (i < n) {
      var ch = src[i];
      if (/\s/.test(ch)) { i++; continue; }
      if (/[0-9.]/.test(ch)) {
        m = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i));
        if (!m) throw err('公式里的数字写得不对：' + src.slice(i, i + 12));
        t.push({ k: 'num', v: Number(m[0]) });
        i += m[0].length;
        continue;
      }
      if (/[A-Za-z_\u4e00-\u9fa5]/.test(ch)) {
        m = /^[A-Za-z_\u4e00-\u9fa5][A-Za-z0-9_\u4e00-\u9fa5]*/.exec(src.slice(i));
        t.push({ k: 'id', v: m[0] });
        i += m[0].length;
        continue;
      }
      if ('+-*/^(),'.indexOf(ch) >= 0) { t.push({ k: ch }); i++; continue; }
      throw err('公式里有不认识的字符「' + ch + '」');
    }
    t.push({ k: 'eof' });
    return t;
  }

  function parse(src, varNames) {
    var toks = tokenize(src), p = 0;
    function peek() { return toks[p]; }
    function next() { return toks[p++]; }
    function expect(k, what) {
      if (toks[p].k !== k) throw err('公式里缺少' + (what || '「' + k + '」'));
      return toks[p++];
    }
    function parseExpr() {
      var node = parseTerm();
      while (peek().k === '+' || peek().k === '-') {
        var op = next().k;
        node = { t: 'bin', op: op, a: node, b: parseTerm() };
      }
      return node;
    }
    function parseTerm() {
      var node = parseUnary();
      while (peek().k === '*' || peek().k === '/') {
        var op = next().k;
        node = { t: 'bin', op: op, a: node, b: parseUnary() };
      }
      return node;
    }
    function parseUnary() {
      if (peek().k === '-') { next(); return { t: 'neg', a: parseUnary() }; }
      if (peek().k === '+') { next(); return parseUnary(); }
      return parsePower();
    }
    function parsePower() {
      var base = parseAtom();
      if (peek().k === '^') { next(); return { t: 'bin', op: '^', a: base, b: parseUnary() }; }
      return base;
    }
    function parseAtom() {
      var tk = peek();
      if (tk.k === 'num') { next(); return { t: 'num', v: tk.v }; }
      if (tk.k === '(') { next(); var e = parseExpr(); expect(')', '右括号「)」'); return e; }
      if (tk.k === 'id') {
        next();
        var name = tk.v;
        if (peek().k === '(') {
          next();
          var args = [];
          if (peek().k !== ')') {
            args.push(parseExpr());
            while (peek().k === ',') { next(); args.push(parseExpr()); }
          }
          expect(')', '右括号「)」');
          if (FUNC_NAMES.indexOf(name) < 0) throw err('不支持的函数「' + name + '」（可用：' + FUNC_NAMES.join('、') + '）');
          if (args.length !== 1) throw err('函数「' + name + '」只接受 1 个参数');
          return { t: 'fn', name: name, a: args[0] };
        }
        if (varNames.indexOf(name) >= 0) return { t: 'var', name: name };
        if (Object.prototype.hasOwnProperty.call(CONSTS, name)) return { t: 'num', v: CONSTS[name] };
        throw err('公式里的「' + name + '」不在变量表里');
      }
      throw err('公式在这里断了：第 ' + (p + 1) + ' 个符号没构成一个完整项');
    }
    var ast = parseExpr();
    if (peek().k !== 'eof') throw err('公式结尾有多余内容');
    return ast;
  }

  function isConstNode(node) {
    switch (node.t) {
      case 'num': return true;
      case 'var': return false;
      case 'neg': return isConstNode(node.a);
      case 'fn': return isConstNode(node.a);
      case 'bin': return isConstNode(node.a) && isConstNode(node.b);
    }
    return false;
  }

  function collectVars(node, out) {
    if (!node) return out;
    if (node.t === 'var') { if (out.indexOf(node.name) < 0) out.push(node.name); }
    else if (node.t === 'neg' || node.t === 'fn') collectVars(node.a, out);
    else if (node.t === 'bin') { collectVars(node.a, out); collectVars(node.b, out); }
    return out;
  }

  // ── 对偶数（值 + 梯度向量）与运算 ───────────────────────────
  function zeros(n) { var d = []; for (var i = 0; i < n; i++) d.push(0); return d; }
  function dual(v, d) { return { v: v, d: d }; }
  function isConstDual(x) { for (var i = 0; i < x.d.length; i++) if (x.d[i] !== 0) return false; return true; }

  function evalDual(ast, env, n) {
    var i, a, b, d, v, c, s;
    switch (ast.t) {
      case 'num':
        return dual(ast.v, zeros(n));
      case 'var':
        if (!env[ast.name]) throw err('变量「' + ast.name + '」没有值');
        return dual(env[ast.name].v, env[ast.name].d.slice());
      case 'neg':
        a = evalDual(ast.a, env, n);
        d = []; for (i = 0; i < n; i++) d.push(-a.d[i]);
        return dual(-a.v, d);
      case 'bin':
        a = evalDual(ast.a, env, n);
        b = evalDual(ast.b, env, n);
        if (ast.op === '+') {
          d = []; for (i = 0; i < n; i++) d.push(a.d[i] + b.d[i]);
          return dual(a.v + b.v, d);
        }
        if (ast.op === '-') {
          d = []; for (i = 0; i < n; i++) d.push(a.d[i] - b.d[i]);
          return dual(a.v - b.v, d);
        }
        if (ast.op === '*') {
          d = []; for (i = 0; i < n; i++) d.push(a.d[i] * b.v + b.d[i] * a.v);
          return dual(a.v * b.v, d);
        }
        if (ast.op === '/') {
          if (b.v === 0) throw err('公式里出现了除以 0');
          d = []; for (i = 0; i < n; i++) d.push((a.d[i] * b.v - a.v * b.d[i]) / (b.v * b.v));
          return dual(a.v / b.v, d);
        }
        if (ast.op === '^') {
          if (isConstNode(ast.b)) {
            v = Math.pow(a.v, b.v);
            if (!isFinite(v)) throw err('幂运算在当前的数值下没有实数结果（如负数开偶次方）');
            var w = b.v * Math.pow(a.v, b.v - 1);
            if (!isFinite(w)) throw err('幂运算的导数在当前数值下没有定义（底数 0 配 0～1 之间的指数）');
            d = []; for (i = 0; i < n; i++) d.push(w * a.d[i]);
            return dual(v, d);
          }
          if (a.v <= 0) throw err('指数本身也是变量时，底数必须大于 0');
          v = Math.pow(a.v, b.v);
          if (!isFinite(v)) throw err('幂运算结果溢出');
          var lb = Math.log(a.v);
          d = [];
          for (i = 0; i < n; i++) d.push(v * (b.d[i] * lb + b.v * a.d[i] / a.v));
          return dual(v, d);
        }
        throw err('不支持的运算符「' + ast.op + '」');
      case 'fn':
        a = evalDual(ast.a, env, n);
        switch (ast.name) {
          case 'sqrt':
            if (a.v < 0) throw err('sqrt 的参数不能是负数');
            v = Math.sqrt(a.v);
            if (v === 0) {
              if (!isConstDual(a)) throw err('在 0 处开方，导数为无穷，误差无法传播');
              return dual(0, zeros(n));
            }
            d = []; for (i = 0; i < n; i++) d.push(a.d[i] / (2 * v));
            return dual(v, d);
          case 'abs':
            if (a.v === 0) throw err('在 0 处取绝对值，导数没有定义');
            s = a.v > 0 ? 1 : -1;
            d = []; for (i = 0; i < n; i++) d.push(s * a.d[i]);
            return dual(Math.abs(a.v), d);
          case 'ln':
            if (a.v <= 0) throw err('ln 的参数必须大于 0');
            d = []; for (i = 0; i < n; i++) d.push(a.d[i] / a.v);
            return dual(Math.log(a.v), d);
          case 'log10':
            if (a.v <= 0) throw err('log10 的参数必须大于 0');
            d = []; for (i = 0; i < n; i++) d.push(a.d[i] / (a.v * Math.LN10));
            return dual(Math.log10(a.v), d);
          case 'exp':
            v = Math.exp(a.v);
            if (!isFinite(v)) throw err('exp 结果溢出');
            d = []; for (i = 0; i < n; i++) d.push(v * a.d[i]);
            return dual(v, d);
          case 'sin':
            c = Math.cos(a.v);
            d = []; for (i = 0; i < n; i++) d.push(c * a.d[i]);
            return dual(Math.sin(a.v), d);
          case 'cos':
            s = -Math.sin(a.v);
            d = []; for (i = 0; i < n; i++) d.push(s * a.d[i]);
            return dual(Math.cos(a.v), d);
          case 'tan':
            c = Math.cos(a.v);
            if (Math.abs(c) < 1e-12) throw err('tan 在这个角度附近没有定义');
            d = []; for (i = 0; i < n; i++) d.push(a.d[i] / (c * c));
            return dual(Math.tan(a.v), d);
        }
        throw err('不支持的函数「' + ast.name + '」');
    }
    throw err('公式结构无法识别');
  }

  // ── 确定性伪随机与正态抽样（固定种子，可复现） ──────────────
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function normalPair(rnd) {
    var u = rnd();
    if (u < 1e-12) u = 1e-12;
    var v = rnd();
    var r = Math.sqrt(-2 * Math.log(u));
    return [r * Math.cos(2 * Math.PI * v), r * Math.sin(2 * Math.PI * v)];
  }

  // ── 输入规范化 ──────────────────────────────────────────────
  function normVars(raw) {
    if (!raw || !raw.length) throw err('至少要有一个变量');
    if (raw.length > LIMITS.MAX_VARS) throw err('变量最多 ' + LIMITS.MAX_VARS + ' 个，请把不参与误差分析的常数写进公式');
    var out = [], seen = {};
    for (var i = 0; i < raw.length; i++) {
      var r = raw[i] || {};
      var name = String(r.name === null || r.name === undefined ? '' : r.name).trim();
      var label = '第 ' + (i + 1) + ' 个变量';
      if (!name) throw err(label + '的名称不能为空');
      if (name.length > LIMITS.MAX_NAME) throw err('变量名「' + name + '」超过 ' + LIMITS.MAX_NAME + ' 个字符');
      if (!IDENT_RE.test(name)) throw err('变量名「' + name + '」只能用中文、字母、数字和下划线，且不能以数字开头');
      if (FUNC_NAMES.indexOf(name) >= 0) throw err('变量名不能叫「' + name + '」，那是函数名');
      if (Object.prototype.hasOwnProperty.call(CONSTS, name)) throw err('变量名不能叫「' + name + '」，那是内置常数');
      if (seen[name]) throw err('变量名「' + name + '」重复了');
      seen[name] = 1;
      var mode = r.mode === 'rel' ? 'rel' : 'abs';
      var value = numStrict(r.value, '变量「' + name + '」的数值');
      var er = numStrict(r.err === '' || r.err === null || r.err === undefined ? 0 : r.err, '变量「' + name + '」的误差');
      if (er < 0) throw err('变量「' + name + '」的误差不能是负数');
      if (Math.abs(er) > LIMITS.MAX_ABS_ERR) throw err('变量「' + name + '」的误差超出上限');
      if (mode === 'rel' && er > LIMITS.MAX_REL_ERR) throw err('变量「' + name + '」的相对误差不能超过 ' + LIMITS.MAX_REL_ERR + ' %');
      var sigma = mode === 'rel' ? Math.abs(value) * er / 100 : er;
      out.push({
        name: name, value: value, mode: mode, err: er, unit: String(r.unit == null ? '' : r.unit).trim().slice(0, 8),
        sigma: sigma, errLabel: mode === 'rel' ? '±' + fmt(er, 6) + '%' : '±' + fmt(er, 6) + (String(r.unit == null ? '' : r.unit).trim() ? ' ' + String(r.unit).trim() : '')
      });
    }
    return out;
  }

  // ── 主入口 ──────────────────────────────────────────────────
  function solve(input) {
    input = input || {};
    var vars = normVars(input.vars);
    var expr = String(input.expr === null || input.expr === undefined ? '' : input.expr).trim();
    if (!expr) throw err('请先写一个公式，例如 长*宽');
    if (expr.length > LIMITS.MAX_EXPR) throw err('公式最多 ' + LIMITS.MAX_EXPR + ' 个字符');

    var names = vars.map(function (v) { return v.name; });
    var ast = parse(expr, names);
    var usedNames = collectVars(ast, []);

    var env = {}, n = vars.length, i, k;
    for (i = 0; i < n; i++) {
      var d = [];
      for (k = 0; k < n; k++) d.push(k === i ? 1 : 0);
      env[vars[i].name] = dual(vars[i].value, d);
    }
    var res = evalDual(ast, env, n);
    var f = res.v;
    if (!isFinite(f)) throw err('公式在当前数值下算不出有限结果');

    // 每个变量的导数、σ、贡献项
    var sumSq = 0;
    for (i = 0; i < n; i++) {
      var vv = vars[i];
      vv.grad = res.d[i];
      vv.term = vv.grad * vv.sigma;
      vv.used = usedNames.indexOf(vv.name) >= 0;
      vv.elasticityAbs = vv.grad * vv.value;
      vv.sensitivityPct = f !== 0 ? vv.elasticityAbs / f * 100 : null;
      sumSq += vv.term * vv.term;
    }
    var sigmaF = Math.sqrt(sumSq);
    for (i = 0; i < n; i++) {
      vars[i].contributionPct = sumSq > 0 ? vars[i].term * vars[i].term / sumSq * 100 : 0;
      vars[i].termAbs = Math.abs(vars[i].term);
    }
    var relPct = f !== 0 ? sigmaF / Math.abs(f) * 100 : null;

    var dominant = null;
    for (i = 0; i < n; i++) {
      if (!vars[i].used) continue;
      if (dominant === null || vars[i].contributionPct > dominant.contributionPct) dominant = vars[i];
    }
    if (dominant && dominant.contributionPct <= 0) dominant = null;

    // 角点扫描：每个变量 ±1σ 的 2^n 个顶点
    var corners = { count: Math.pow(2, n), min: null, max: null, minVars: [], maxVars: [] };
    if (n <= LIMITS.MAX_VARS) {
      for (var mask = 0; mask < corners.count; mask++) {
        var cenv = {}, pick = [];
        for (i = 0; i < n; i++) {
          var sign = (mask >> i) & 1 ? 1 : -1;
          var cv = vars[i].value + sign * vars[i].sigma;
          cenv[vars[i].name] = dual(cv, zeros(0));
          pick.push(vars[i].name + '=' + fmt(cv, 6));
        }
        var cvres = evalDual(ast, cenv, 0);
        if (!isFinite(cvres.v)) continue;
        if (corners.min === null || cvres.v < corners.min) { corners.min = cvres.v; corners.minVars = pick.slice(); }
        if (corners.max === null || cvres.v > corners.max) { corners.max = cvres.v; corners.maxVars = pick.slice(); }
      }
    }

    // 蒙特卡洛对照（固定种子）
    var samples = Number(input.mcSamples) || LIMITS.MC_DEFAULT;
    if (LIMITS.MC_OPTIONS.indexOf(samples) < 0) samples = LIMITS.MC_DEFAULT;
    var rnd = mulberry32(LIMITS.MC_SEED);
    var vals = [], nonFinite = 0, sum = 0;
    for (var s = 0; s < samples; s++) {
      var menv = {};
      for (i = 0; i < n; i++) {
        var zz = normalPair(rnd)[0];
        var mval = vars[i].sigma > 0 ? vars[i].value + vars[i].sigma * zz : vars[i].value;
        menv[vars[i].name] = dual(mval, zeros(0));
      }
      var mv;
      try { mv = evalDual(ast, menv, 0).v; } catch (e) { mv = NaN; }
      if (!isFinite(mv)) { nonFinite++; continue; }
      if (!isFinite(mv)) { nonFinite++; continue; }
      vals.push(mv); sum += mv;
    }
    vals.sort(function (a, b) { return a - b; });
    var mc = { samples: samples, used: vals.length, nonFinite: nonFinite, seed: LIMITS.MC_SEED };
    if (vals.length) {
      var mean = sum / vals.length, ss = 0;
      for (i = 0; i < vals.length; i++) ss += (vals[i] - mean) * (vals[i] - mean);
      mc.mean = mean;
      mc.sd = vals.length > 1 ? Math.sqrt(ss / (vals.length - 1)) : 0;
      mc.min = vals[0];
      mc.max = vals[vals.length - 1];
      mc.p05 = quantile(vals, 0.05);
      mc.p95 = quantile(vals, 0.95);
    }
    mc.deviationPct = (mc.sd !== undefined && sigmaF > 0) ? (mc.sd - sigmaF) / sigmaF * 100 : null;
    mc.biasPct = (mc.mean !== undefined && f !== 0) ? (mc.mean - f) / Math.abs(f) * 100 : null;

    function toErrValue(v, sigma) {
      return v.mode === 'rel' ? (v.value !== 0 ? sigma / Math.abs(v.value) * 100 : 0) : sigma;
    }
    function toErrLabel(v, sigma) {
      return v.mode === 'rel' ? '±' + fmt(toErrValue(v, sigma), 4) + '%'
        : '±' + fmt(sigma, 6) + (v.unit ? ' ' + v.unit : '');
    }

    // 目标精度反推
    var target = null;
    var tMode = input.target && input.target.mode === 'rel' ? 'rel' : 'abs';
    var tRaw = input.target ? String(input.target.value === null || input.target.value === undefined ? '' : input.target.value).trim() : '';
    if (tRaw !== '') {
      var tVal = numStrict(tRaw, '目标精度');
      if (tVal < 0) throw err('目标精度不能是负数');
      if (tVal > 0) {
        var sigmaTarget = tMode === 'rel' ? Math.abs(f) * tVal / 100 : tVal;
        var kScale = sigmaF > 0 ? sigmaTarget / sigmaF : 0;
        target = {
          mode: tMode, value: tVal, label: tMode === 'rel' ? '相对 ±' + fmt(tVal, 6) + '%' : '绝对 ±' + fmt(tVal, 6),
          sigmaTarget: sigmaTarget, feasible: sigmaF <= sigmaTarget, scaleK: kScale,
          rows: vars.map(function (v) {
            var needSigma = kScale * v.sigma;
            var needErr = toErrValue(v, needSigma);
            return {
              name: v.name,
              requiredSigma: needSigma,
              requiredErr: needErr,
              requiredLabel: toErrLabel(v, needSigma),
              currentErr: v.err,
              currentLabel: v.mode === 'rel' ? '±' + fmt(v.err, 4) + '%' : '±' + fmt(v.err, 4) + (v.unit ? ' ' + v.unit : ''),
              tightenPct: v.err > 0 ? (1 - needErr / v.err) * 100 : null
            };
          })
        };
      }
    }

    // 改进优先级：只改一个变量时，它需要降到哪里
    var priority = vars.map(function (v) {
      var row = {
        name: v.name, unit: v.unit, mode: v.mode, value: v.value,
        currentErr: v.err, currentSigma: v.sigma,
        currentLabel: v.mode === 'rel' ? '±' + fmt(v.err, 4) + '%' : '±' + fmt(v.err, 4) + (v.unit ? ' ' + v.unit : '')
      };
      if (v.grad === 0) {
        row.possible = false;
        row.reason = '它不出现在公式里（或对结果的偏导为 0），改它对结果没有影响';
        return row;
      }
      if (v.sigma === 0) {
        row.possible = false;
        row.reason = '它现在的误差已经是 0，没有可收紧的空间；要降低结果的不确定度只能改别的变量';
        return row;
      }
      if (!target) { row.possible = null; row.reason = '未设定目标精度'; return row; }
      var otherSumSq = sumSq - v.term * v.term;
      var need = target.sigmaTarget * target.sigmaTarget - otherSumSq;
      if (need < 0) {
        row.possible = false;
        row.reason = '单靠它不够：其余 ' + (n - 1) + ' 项已经占了 ' + fmt(Math.sqrt(otherSumSq), 4) + '，超过目标的 ' + fmt(target.sigmaTarget, 4) + '，必须同时改多个';
        row.requiredSigma = null;
        return row;
      }
      var needSigma = Math.sqrt(need) / Math.abs(v.grad);
      row.possible = true;
      row.requiredSigma = needSigma;
      row.requiredErr = toErrValue(v, needSigma);
      row.requiredLabel = toErrLabel(v, needSigma);
      row.improveFactor = v.sigma > 0 ? v.sigma / needSigma : null;
      return row;
    });

    // 建议
    var advice = [];
    var usedVars = vars.filter(function (v) { return v.used; });
    if (sigmaF === 0) {
      advice.push({ level: 'ok', text: '所有变量的误差都是 0，结果没有不确定度——但真实测量几乎不可能如此，请检查是否忘了填误差。' });
    } else {
      if (dominant) {
        var second = usedVars.slice().sort(function (a, b) { return b.contributionPct - a.contributionPct; })[1];
        function relShareOf(v) { return Math.abs(v.value) !== 0 ? v.sigma / Math.abs(v.value) * 100 : null; }
        var txt = '结果的不确定度主要来自「' + dominant.name + '」，贡献 ' + fmt(dominant.contributionPct, 4) + '%'
          + (second ? '；其次是「' + second.name + '」（' + fmt(second.contributionPct, 4) + '%）' : '')
          + '。每个变量贡献的那一份 = |∂f/∂x| × 该变量的误差：「' + dominant.name + '」的 |∂f/∂x| = ' + fmt(Math.abs(dominant.grad), 6)
          + '，误差 ' + dominant.errLabel + '，这一份是 ' + fmt(Math.abs(dominant.term), 6) + '。';
        if (second && relShareOf(dominant) !== null && relShareOf(second) !== null) {
          var rd = relShareOf(dominant), rs = relShareOf(second);
          if (rd > rs && Math.abs(dominant.value) < Math.abs(second.value)) {
            txt += '两者的绝对误差大小接近，但「' + dominant.name + '」的数值 ' + fmt(dominant.value, 6)
              + ' 比「' + second.name + '」的 ' + fmt(second.value, 6) + ' 小，同样的误差占它自身的 ' + fmt(rd, 3)
              + '%，占后者只有 ' + fmt(rs, 3) + '%——误差落在越小的量上，相对影响越大，所以更该先量准它。';
          }
        }
        advice.push({ level: 'key', text: txt,
          short: '误差主要来自「' + dominant.name + '」（' + fmt(dominant.contributionPct, 3) + '%）'
            + (second ? '，其次是「' + second.name + '」（' + fmt(second.contributionPct, 3) + '%）' : '')
            + '。同样的绝对误差落在数值更小的量上影响更大，先量准「' + dominant.name + '」。' });
      }
      if (target) {
        if (target.feasible) {
          advice.push({ level: 'ok', text: '当前不确定度 ±' + fmt(sigmaF, 5) + ' 已经满足目标 ' + target.label + '（±' + fmt(target.sigmaTarget, 5) + '），还有 ' + fmt(target.sigmaTarget / (sigmaF || 1), 4) + ' 倍余量，不需要再收紧测量。',
            short: '当前 ±' + fmt(sigmaF, 5) + ' 已满足目标 ' + target.label + '，还有 ' + fmt(target.sigmaTarget / (sigmaF || 1), 3) + ' 倍余量。' });
        } else {
          advice.push({
            level: 'warn',
            text: '当前 ±' + fmt(sigmaF, 5) + ' 不满足目标 ' + target.label + '（±' + fmt(target.sigmaTarget, 5) + '），所有测量误差都要压到现在的 ' + fmt(target.scaleK, 4) + ' 倍以内。',
            short: '当前 ±' + fmt(sigmaF, 5) + ' 不满足目标 ' + target.label + '：所有测量误差都要压到现在的 ' + fmt(target.scaleK, 4) + ' 倍以内。'
          });
          var best = priority.filter(function (p) { return p.possible === true; })
            .sort(function (a, b) { return (a.improveFactor || 0) - (b.improveFactor || 0); })[0];
          if (best) {
        advice.push({
          level: 'act',
          text: '只改「' + best.name + '」一条最省事：把它收紧到 ' + best.requiredLabel + '（现在是 ' + best.currentLabel + '），就能单独满足目标。',
          short: '只改「' + best.name + '」一条最省事：收紧到 ' + best.requiredLabel + ' 就能单独达标（现在 ' + best.currentLabel + '）。',
          apply: { name: best.name, requiredErr: best.requiredErr, mode: best.mode, value: best.value }
        });
      } else {
        advice.push({ level: 'warn', text: '没有任何单一变量的改进能达标：必须同时收紧多个变量，或放宽目标。' });
      }
        }
      } else {
        advice.push({ level: 'info', text: '填一个目标精度，本页会反推每个变量最多只能有多少误差、以及只改哪一个最省事。' });
      }
      if (mc.sd !== undefined && mc.deviationPct !== null && Math.abs(mc.deviationPct) > 5) {
        advice.push({
          level: 'warn',
          text: '蒙特卡洛（' + samples + ' 次）算出的标准差 ' + fmt(mc.sd, 5) + ' 与一阶传播的 ' + fmt(sigmaF, 5)
            + ' 相差 ' + fmt(mc.deviationPct, 3) + '%，说明误差已经不小、或公式非线性较强，一阶近似偏乐观，请以蒙特卡洛为准并谨慎使用。'
        });
      } else if (mc.sd !== undefined) {
        advice.push({ level: 'ok', text: '蒙特卡洛（' + samples + ' 次）算出的标准差 ' + fmt(mc.sd, 5) + ' 与一阶传播 ' + fmt(sigmaF, 5) + ' 相差 ' + fmt(mc.deviationPct, 3) + '%，两者一致，说明当前误差量级下一阶线性化是可靠的。',
          short: '蒙特卡洛与一阶传播只差 ' + fmt(mc.deviationPct, 3) + '%，小误差 + 近似线性的假设站得住。' });
      }
    }
    vars.forEach(function (v) {
      if (!v.used) advice.push({ level: 'info', text: '「' + v.name + '」没有出现在公式里，它的误差不影响结果。' });
    });

    var warnings = [
      '各变量的误差被当作互相独立的随机误差处理；如果两个变量来自同一把尺子、同一次读数或同一个换算（相关误差），公式 σ=√Σ(∂f/∂x·σ)² 会低估结果的不确定度。',
      '一阶（线性）近似：只有当误差相对数值足够小、公式在这一点附近近似线性时才准。误差偏大时请看蒙特卡洛一列。',
      '本页不做量纲检查：只保证数值算得对，不保证你写的公式在物理/几何上成立，也不检查各变量的单位是否自洽。',
      '角点扫描只是每个变量取 ±1σ 时的 2ⁿ 个顶点，不是严格的区间上下界；非线性强时真实极值可能落在角点之外。',
      '蒙特卡洛用固定种子 ' + LIMITS.MC_SEED + ' 抽样 ' + samples + ' 次、并假设各误差服从正态分布；它是模拟，不是你手上这把尺子的实测误差分布。',
      '默认样例的数值是虚构示例，不是任何真实工程测量的误差分布。',
      '不处理系统误差（尺子本身偏了）、不处理相关误差、不处理有偏分布，也不给出计量校准或安全判定的结论。'
    ];

    return {
      expr: expr, vars: vars, varCount: n, usedCount: usedVars.length,
      resultName: String(input.resultName == null || String(input.resultName).trim() === '' ? '结果' : String(input.resultName).trim().slice(0, 20)),
      resultUnit: String(input.resultUnit == null ? '' : input.resultUnit).trim().slice(0, 10),
      f: f, sigmaF: sigmaF, relPct: relPct,
      dominant: dominant ? dominant.name : null,
      dominantContributionPct: dominant ? dominant.contributionPct : null,
      target: target, priority: priority, corners: corners, mc: mc, advice: advice, warnings: warnings
    };
  }

  function quantile(sorted, p) {
    if (!sorted.length) return null;
    var idx = (sorted.length - 1) * p, lo = Math.floor(idx), hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  }

  var sample = {
    resultName: '地板采购面积',
    resultUnit: 'm²',
    vars: [
      { name: '长', value: '4.25', mode: 'abs', err: '0.01', unit: 'm' },
      { name: '宽', value: '3.10', mode: 'abs', err: '0.01', unit: 'm' },
      { name: '损耗率', value: '5', mode: 'rel', err: '0', unit: '%' }
    ],
    expr: '长*宽*(1+损耗率/100)',
    target: { mode: 'abs', value: '0.05' },
    mcSamples: LIMITS.MC_DEFAULT
  };

  // 内置场景全部虚构，只用来演示口径，不代表任何真实测量。
  var presets = [
    {
      key: 'floor', name: '地板采购面积（默认）',
      resultName: '地板采购面积', resultUnit: 'm²',
      vars: [
        { name: '长', value: '4.25', mode: 'abs', err: '0.01', unit: 'm' },
        { name: '宽', value: '3.10', mode: 'abs', err: '0.01', unit: 'm' },
        { name: '损耗率', value: '5', mode: 'rel', err: '0', unit: '%' }
      ],
      expr: '长*宽*(1+损耗率/100)', target: { mode: 'abs', value: '0.05' }
    },
    {
      key: 'cylinder', name: '圆柱体积',
      resultName: '圆柱体积', resultUnit: 'cm³',
      vars: [
        { name: '半径', value: '12.5', mode: 'abs', err: '0.05', unit: 'cm' },
        { name: '高', value: '40', mode: 'abs', err: '0.1', unit: 'cm' }
      ],
      expr: 'pi*半径^2*高', target: { mode: 'abs', value: '5' }
    },
    {
      key: 'density', name: '块体密度',
      resultName: '密度', resultUnit: 'g/cm³',
      vars: [
        { name: '质量', value: '253.4', mode: 'abs', err: '0.05', unit: 'g' },
        { name: '长', value: '10.02', mode: 'abs', err: '0.01', unit: 'cm' },
        { name: '宽', value: '5.00', mode: 'abs', err: '0.01', unit: 'cm' },
        { name: '高', value: '2.00', mode: 'abs', err: '0.01', unit: 'cm' }
      ],
      expr: '质量/(长*宽*高)', target: { mode: 'rel', value: '1' }
    },
    {
      key: 'parallel', name: '两只电阻并联',
      resultName: '并联总阻值', resultUnit: 'Ω',
      vars: [
        { name: 'r1', value: '100', mode: 'abs', err: '1', unit: 'Ω' },
        { name: 'r2', value: '150', mode: 'abs', err: '1', unit: 'Ω' }
      ],
      expr: '1/(1/r1+1/r2)', target: { mode: 'abs', value: '0.5' }
    },
    {
      key: 'spending', name: '客单价（总额÷单数）',
      resultName: '客单价', resultUnit: '元',
      vars: [
        { name: '总额', value: '12800', mode: 'abs', err: '50', unit: '元' },
        { name: '单数', value: '160', mode: 'abs', err: '2', unit: '单' }
      ],
      expr: '总额/单数', target: { mode: 'rel', value: '1' }
    }
  ];

  var api = {
    LIMITS: LIMITS, FUNC_NAMES: FUNC_NAMES, CONSTS: CONSTS,
    tokenize: tokenize, parse: parse, evalDual: evalDual, isConstNode: isConstNode, collectVars: collectVars,
    solve: solve, fmt: fmt, numStrict: numStrict, normVars: normVars,
    quantile: quantile, mulberry32: mulberry32, normalPair: normalPair,
    sample: sample, presets: presets
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (global) global.AppCore = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
