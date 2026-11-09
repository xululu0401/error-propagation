/* 误差传播台 · ui.js —— 界面、导出与本地持久化（纯前端，不联网） */
(function () {
  'use strict';
  var C = window.AppCore;
  var STORE = 'error-propagation-ledger-v1';
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function unitTxt(u) { return u ? ' ' + esc(u) : ''; }
  function pct(x, d) { return C.fmt(x, d || 4) + '%'; }

  /** 把「值 ± 不确定度」按不确定度的首位对齐到同一位小数（计量习惯）。 */
  function pair(f, s) {
    if (typeof f !== 'number' || !isFinite(f)) return { v: '—', s: '—' };
    if (!isFinite(s) || s === 0) return { v: C.fmt(f, 6), s: '0' };
    var exp = Math.floor(Math.log10(Math.abs(s)));
    var dec = -exp + 1;
    if (dec < 0 || dec > 10 || Math.abs(f) >= 1e7) return { v: C.fmt(f, 6), s: C.fmt(s, 4) };
    return { v: f.toFixed(dec), s: s.toFixed(dec) };
  }

  // ── 输入状态 ────────────────────────────────────────────────
  var vars = [], expr = '', resultName = '', resultUnit = '';
  var target = { mode: 'abs', value: '' }, mcSamples = C.LIMITS.MC_DEFAULT;

  function blankVar() { return { name: '', value: '', mode: 'abs', err: '', unit: '' }; }

  function varRowHTML(v, i) {
    return '<div class="item" data-i="' + i + '">'
      + '<div class="item-head"><span class="idx">' + (i + 1) + '</span>'
      + '<input type="text" class="vname" value="' + esc(v.name) + '" placeholder="变量名，如 长" aria-label="第 ' + (i + 1) + ' 个变量名">'
      + '<button type="button" class="mini del" data-del="' + i + '" aria-label="删除第 ' + (i + 1) + ' 个变量">删除</button></div>'
      + '<div class="grid4">'
      + '<label class="f"><span>数值</span><input type="text" inputmode="decimal" class="vval" value="' + esc(v.value) + '" aria-label="第 ' + (i + 1) + ' 个变量数值"></label>'
      + '<label class="f"><span>误差口径</span><select class="vmode" aria-label="第 ' + (i + 1) + ' 个变量误差口径">'
      + '<option value="abs"' + (v.mode === 'abs' ? ' selected' : '') + '>绝对 ±</option>'
      + '<option value="rel"' + (v.mode === 'rel' ? ' selected' : '') + '>相对 ±%</option></select></label>'
      + '<label class="f"><span>误差大小</span><input type="text" inputmode="decimal" class="verr" value="' + esc(v.err) + '" aria-label="第 ' + (i + 1) + ' 个变量误差大小"></label>'
      + '<label class="f"><span>单位（只用于显示）</span><input type="text" class="vunit" value="' + esc(v.unit) + '" aria-label="第 ' + (i + 1) + ' 个变量单位"></label>'
      + '</div></div>';
  }
  function renderVars() {
    $('vars').innerHTML = vars.map(varRowHTML).join('');
  }

  function readInput() {
    return {
      resultName: $('resultName').value,
      resultUnit: $('resultUnit').value,
      vars: vars.map(function (v) { return { name: v.name, value: v.value, mode: v.mode, err: v.err, unit: v.unit }; }),
      expr: $('expr').value,
      target: { mode: $('targetMode').value, value: $('targetValue').value },
      mcSamples: Number($('mcSamples').value)
    };
  }
  function fillForm(inp) {
    vars = (inp.vars || []).map(function (v) {
      return { name: v.name || '', value: v.value === undefined || v.value === null ? '' : String(v.value), mode: v.mode === 'rel' ? 'rel' : 'abs', err: v.err === undefined || v.err === null ? '' : String(v.err), unit: v.unit || '' };
    });
    if (!vars.length) vars = [blankVar()];
    expr = inp.expr === undefined || inp.expr === null ? '' : String(inp.expr);
    resultName = inp.resultName === undefined || inp.resultName === null ? '' : String(inp.resultName);
    resultUnit = inp.resultUnit === undefined || inp.resultUnit === null ? '' : String(inp.resultUnit);
    target = { mode: inp.target && inp.target.mode === 'rel' ? 'rel' : 'abs', value: inp.target && inp.target.value !== undefined && inp.target.value !== null ? String(inp.target.value) : '' };
    mcSamples = Number(inp.mcSamples) || C.LIMITS.MC_DEFAULT;
    if (C.LIMITS.MC_OPTIONS.indexOf(mcSamples) < 0) mcSamples = C.LIMITS.MC_DEFAULT;
    $('expr').value = expr;
    $('resultName').value = resultName;
    $('resultUnit').value = resultUnit;
    $('targetMode').value = target.mode;
    $('targetValue').value = target.value;
    $('mcSamples').value = String(mcSamples);
    renderVars();
  }

  function setMessage(t) { $('message').textContent = t || ''; }

  // ── 主流程 ──────────────────────────────────────────────────
  var lastSolved = null;
  function run() {
    var r;
    try {
      r = C.solve(readInput());
    } catch (e) {
      lastSolved = null;
      $('error').textContent = '✕ ' + (e.userMessage || e.message);
      $('result').innerHTML = '<p class="hint">按左侧提示改正输入后会自动重新计算。</p>';
      $('downloads').style.display = 'none';
      return;
    }
    $('error').textContent = '';
    lastSolved = r;
    window.__lastResult = r;
    $('downloads').style.display = '';
    render(r);
    autosave();
  }

  // ── 渲染 ────────────────────────────────────────────────────
  function render(r) {
    var H = [];
    var p = pair(r.f, r.sigmaF);
    var u = unitTxt(r.resultUnit);
    H.push('<h2>结果</h2>');
    H.push('<div class="metric">' + esc(r.resultName) + ' = <strong>' + p.v + '</strong>'
      + ' <span class="pm">± ' + p.s + '</span>' + u + '</div>');
    if (r.relPct === null) {
      H.push('<div class="note">结果正好是 0，相对不确定度没有意义，因此只报绝对不确定度。</div>');
    } else {
      H.push('<div class="note">相对不确定度 <strong>' + pct(r.relPct) + '</strong>（一阶传播口径：σ_f = √Σ(∂f/∂xᵢ·σᵢ)²，各变量误差互相独立）。</div>');
    }

    // 指标条
    var mcTxt = (r.mc.sd === undefined) ? '—' : C.fmt(r.mc.sd, 4);
    var mcDev = (r.mc.deviationPct === null || r.mc.deviationPct === undefined) ? '—' : (r.mc.deviationPct >= 0 ? '+' : '') + C.fmt(r.mc.deviationPct, 3) + '%';
    H.push('<div class="stats">'
      + '<div><strong>' + r.varCount + '</strong><span>变量个数（参与公式 ' + r.usedCount + '）</span></div>'
      + '<div><strong>' + C.fmt(r.sigmaF, 4) + '</strong><span>一阶不确定度 ' + esc(r.resultUnit) + '</span></div>'
      + '<div><strong>' + mcTxt + '</strong><span>蒙特卡洛标准差（差 ' + mcDev + '）</span></div>'
      + '<div><strong>' + (r.dominant ? esc(r.dominant) : '—') + '</strong><span>主导误差源' + (r.dominantContributionPct !== null ? '（贡献 ' + pct(r.dominantContributionPct, 3) + '）' : '') + '</span></div>'
      + '<div><strong>' + C.fmt(r.corners.min, 5) + ' ~ ' + C.fmt(r.corners.max, 5) + '</strong><span>角点扫描范围（2ⁿ 个顶点）</span></div>'
      + '</div>');

    // 贡献分解
    H.push('<h3>误差贡献分解</h3>');
    H.push('<div class="note">每一项的贡献 = (∂f/∂xᵢ · σᵢ)²，占比合计 100%。谁的条最长，就最该先量准谁。</div>');
    r.vars.slice().sort(function (a, b) { return b.contributionPct - a.contributionPct; }).forEach(function (v) {
      var w = Math.max(0, Math.min(100, v.contributionPct));
      H.push('<div class="barrow"><b>' + esc(v.name) + '</b><span class="bar' + (w >= 50 ? ' hot' : '') + '"><i style="width:' + w.toFixed(2) + '%"></i></span><span>' + pct(v.contributionPct, 3) + '</span></div>');
    });
    H.push('<div class="scroll"><table class="stack"><thead><tr><th>变量</th><th>数值</th><th>误差</th><th>σᵢ</th><th>∂f/∂xᵢ</th><th>贡献项</th><th>占比</th></tr></thead><tbody>');
    r.vars.forEach(function (v) {
      H.push('<tr' + (v.name === r.dominant ? ' class="cur"' : (v.used ? '' : ' class="dim"')) + '>'
        + '<td data-label="变量">' + esc(v.name) + unitTxt(v.unit) + (v.used ? '' : '<span class="tag">未参与</span>') + '</td>'
        + '<td data-label="数值">' + C.fmt(v.value, 6) + '</td>'
        + '<td data-label="误差">' + esc(v.errLabel) + '</td>'
        + '<td data-label="σᵢ">' + C.fmt(v.sigma, 5) + '</td>'
        + '<td data-label="∂f/∂xᵢ">' + C.fmt(v.grad, 6) + '</td>'
        + '<td data-label="贡献项">' + C.fmt(v.term, 6) + '</td>'
        + '<td data-label="占比">' + pct(v.contributionPct, 3) + '</td></tr>');
    });
    H.push('</tbody></table></div>');

    // 敏感度
    H.push('<h3>敏感度</h3>');
    H.push('<div class="note">弹性 = ∂f/∂xᵢ · xᵢ ÷ f，读作「xᵢ 变 1%，结果变百分之几」；最后一列是「xᵢ 增加 1σ 时结果变多少」（= ∂f/∂xᵢ·σᵢ）。</div>');
    H.push('<div class="scroll"><table class="stack"><thead><tr><th>变量</th><th>弹性</th><th>+1σ 时结果变化</th><th>数值 +1σ 后</th></tr></thead><tbody>');
    r.vars.forEach(function (v) {
      H.push('<tr><td data-label="变量">' + esc(v.name) + '</td>'
        + '<td data-label="弹性">' + (v.sensitivityPct === null ? '—（结果为 0）' : pct(v.sensitivityPct, 4)) + '</td>'
        + '<td data-label="+1σ 时结果变化">' + (v.term >= 0 ? '+' : '') + C.fmt(v.term, 6) + '</td>'
        + '<td data-label="数值 +1σ 后">' + C.fmt(v.value + v.sigma, 6) + unitTxt(v.unit) + '</td></tr>');
    });
    H.push('</tbody></table></div>');

    // 目标反推
    H.push('<h3>目标精度反推</h3>');
    if (!r.target) {
      H.push('<div class="note">还没有设目标精度。在左边填一个（例如绝对 ±0.05，或相对 ±1%），本页会反推每个变量最多只能有多少误差，并告诉你只改哪一个最省事。</div>');
    } else {
      var t = r.target;
      H.push('<div class="note">目标 <strong>' + esc(t.label) + '</strong>'
        + (t.mode === 'rel' ? '（按当前结果折算成绝对 ±' + C.fmt(t.sigmaTarget, 5) + '）' : '')
        + '；当前 ±' + C.fmt(r.sigmaF, 5) + ' → '
        + (t.feasible ? '<span class="tag good">已达标</span>' : '<span class="tag bad">未达标</span>')
        + (t.feasible ? '' : '，所有变量的误差要同时压到现在的 <strong>' + C.fmt(t.scaleK, 4) + ' 倍</strong>以内') + '。</div>');
      H.push('<div class="scroll"><table class="stack"><thead><tr><th>变量</th><th>现在的误差</th><th>等比缩小后需要的误差</th><th>还要收紧</th><th>操作</th></tr></thead><tbody>');
      t.rows.forEach(function (row, i) {
        H.push('<tr><td data-label="变量">' + esc(row.name) + '</td>'
          + '<td data-label="现在的误差">' + esc(row.currentLabel) + '</td>'
          + '<td data-label="需要的误差">' + esc(row.requiredLabel) + '</td>'
          + '<td data-label="还要收紧">' + (row.tightenPct === null ? '—' : (row.tightenPct <= 0 ? '已经够' : C.fmt(row.tightenPct, 3) + '%')) + '</td>'
          + '<td data-label="操作">' + (t.feasible ? '已达标，无需收紧' : (row.currentErr === 0 ? '本来就是 0，不用改' : '<button type="button" class="mini apply" data-i="' + i + '" data-mode="' + t.rows[i].mode + '" data-err="' + esc(String(row.requiredErr)) + '">采用</button>')) + '</td></tr>');
      });
      H.push('</tbody></table></div>');
      if (!t.feasible) {
        H.push('<div class="buttons"><button type="button" id="applyAll" class="primary">把上表全部误差一并采用</button></div>');
      }
    }

    // 改进优先级
    H.push('<h3>只改一个变量：改进优先级</h3>');
    H.push('<div class="note">每一行都是「假设其他变量的误差都不动，只把这个量测得更准」时，它需要达到的精度。倍数越小越省事；标注「做不到」的说明单靠它解决不了。</div>');
    H.push('<div class="scroll"><table class="stack"><thead><tr><th>变量</th><th>现在的误差</th><th>只改它需要的误差</th><th>要压紧的倍数</th><th>判定</th><th>操作</th></tr></thead><tbody>');
    r.priority.forEach(function (row, i) {
      var ok = row.possible === true;
      H.push('<tr' + (ok ? '' : ' class="dim"') + '><td data-label="变量">' + esc(row.name) + '</td>'
        + '<td data-label="现在的误差">' + esc(row.currentLabel) + '</td>'
        + '<td data-label="只改它需要的误差">' + (ok ? esc(row.requiredLabel) : '—') + '</td>'
        + '<td data-label="要压紧的倍数">' + (ok && row.improveFactor ? C.fmt(row.improveFactor, 3) + ' 倍' : '—') + '</td>'
        + '<td data-label="判定">' + (ok ? '<span class="tag good">可行</span>' : '<span class="tag bad">做不到</span>') + '</td>'
        + '<td data-label="操作">' + (ok ? '<button type="button" class="mini apply" data-i="' + i + '" data-name="' + esc(row.name) + '" data-mode="' + row.mode + '" data-err="' + esc(String(row.requiredErr)) + '">采用</button>' : '—') + '</td></tr>');
      if (!ok && row.reason) H.push('<tr class="dim"><td data-label="说明" colspan="6">' + esc(row.reason) + '</td></tr>');
    });
    H.push('</tbody></table></div>');

    // 蒙特卡洛与角点
    H.push('<h3>蒙特卡洛与角点对照</h3>');
    if (r.mc.sd === undefined) {
      H.push('<div class="note">蒙特卡洛没有得到有效样本。</div>');
    } else {
      H.push('<div class="scroll"><table class="stack"><thead><tr><th>口径</th><th>数值</th><th>含义</th></tr></thead><tbody>'
        + '<tr><td data-label="口径">一阶传播 σ_f</td><td data-label="数值">' + C.fmt(r.sigmaF, 6) + '</td><td data-label="含义">√Σ(∂f/∂xᵢ·σᵢ)²</td></tr>'
        + '<tr><td data-label="口径">蒙特卡洛标准差</td><td data-label="数值">' + C.fmt(r.mc.sd, 6) + '</td><td data-label="含义">' + r.mc.used + ' 次有效抽样（共 ' + r.mc.samples + ' 次，种子 ' + r.mc.seed + '，无效 ' + r.mc.nonFinite + ' 次）</td></tr>'
        + '<tr><td data-label="口径">两者相差</td><td data-label="数值">' + (r.mc.deviationPct === null ? '—' : C.fmt(r.mc.deviationPct, 4) + '%') + '</td><td data-label="含义">越小说明「小误差 + 近似线性」的假设越站得住</td></tr>'
        + '<tr><td data-label="口径">蒙特卡洛均值 / 偏差</td><td data-label="数值">' + C.fmt(r.mc.mean, 6) + ' / ' + (r.mc.biasPct === null ? '—' : C.fmt(r.mc.biasPct, 4) + '%') + '</td><td data-label="含义">均值与真值的相对偏差，反映非线性造成的偏移</td></tr>'
        + '<tr><td data-label="口径">5% – 95% 区间</td><td data-label="数值">' + C.fmt(r.mc.p05, 6) + ' ~ ' + C.fmt(r.mc.p95, 6) + '</td><td data-label="含义">约九成样本落在这一区间</td></tr>'
        + '<tr><td data-label="口径">样本极值</td><td data-label="数值">' + C.fmt(r.mc.min, 6) + ' ~ ' + C.fmt(r.mc.max, 6) + '</td><td data-label="含义">' + r.mc.samples + ' 次抽样里的最小与最大（会比 ±1σ 宽得多）</td></tr>'
        + '<tr><td data-label="口径">角点扫描</td><td data-label="数值">' + C.fmt(r.corners.min, 6) + ' ~ ' + C.fmt(r.corners.max, 6) + '</td><td data-label="含义">每个变量取 ±1σ 的 ' + r.corners.count + ' 个顶点上的极值</td></tr>'
        + '</tbody></table></div>');
      H.push('<div class="note">角点最小出现在：' + esc(r.corners.minVars.join('、')) + '；最大出现在：' + esc(r.corners.maxVars.join('、')) + '。</div>');
    }

    // 建议
    H.push('<h3>建议</h3>');
    H.push('<ul class="advice">');
    r.advice.forEach(function (a) {
      H.push('<li class="' + esc(a.level) + '">' + esc(a.text)
        + (a.apply ? ' <button type="button" class="mini apply" data-name="' + esc(a.apply.name) + '" data-mode="' + esc(a.apply.mode) + '" data-err="' + esc(String(a.apply.requiredErr)) + '">采用这个改动</button>' : '')
        + '</li>');
    });
    H.push('</ul>');

    H.push('<details class="model"><summary>本次计算的假设与做不到的地方（点开看）</summary>');
    H.push('<ul class="warnlist">');
    r.warnings.forEach(function (w) { H.push('<li class="info">' + esc(w) + '</li>'); });
    H.push('</ul></details>');

    $('result').innerHTML = H.join('');
    bindResultActions();
  }

  function bindResultActions() {
    Array.prototype.forEach.call($('result').querySelectorAll('button.apply'), function (b) {
      b.addEventListener('click', function () {
        var err = b.getAttribute('data-err');
        var mode = b.getAttribute('data-mode');
        var name = b.getAttribute('data-name');
        var idx = b.getAttribute('data-i');
        var i = -1, k;
        if (name !== null) {
          for (k = 0; k < vars.length; k++) if (vars[k].name === name) { i = k; break; }
        } else {
          i = Number(idx);
        }
        if (i < 0 || i >= vars.length) { setMessage('找不到要修改的变量。'); return; }
        var num = Number(err);
        if (!isFinite(num)) { setMessage('这个改动值算不出来，没有改动输入。'); return; }
        vars[i].err = String(Math.round(num * 1e12) / 1e12);
        if (mode) vars[i].mode = mode;
        renderVars();
        setMessage('已把「' + vars[i].name + '」的误差改为 ' + vars[i].err + (vars[i].mode === 'rel' ? ' %' : '') + '，结果已按新输入重算。');
        run();
      });
    });
    var all = $('applyAll');
    if (all) all.addEventListener('click', function () {
      if (!lastSolved || !lastSolved.target) return;
      var rows = lastSolved.target.rows;
      for (var k = 0; k < rows.length && k < vars.length; k++) {
        var num = Number(rows[k].requiredErr);
        if (isFinite(num)) vars[k].err = String(Math.round(num * 1e12) / 1e12);
      }
      renderVars();
      setMessage('已把等比缩小后需要的误差全部采用，结果已重算。');
      run();
    });
  }

  // ── 持久化 ──────────────────────────────────────────────────
  var saveTimer = null;
  function snapshot() { return { v: 1, savedAt: new Date().toISOString(), input: readInput() }; }
  function autosave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try {
        localStorage.setItem(STORE, JSON.stringify(snapshot()));
        $('savedNote').textContent = '已自动保存到本机（' + new Date().toLocaleTimeString('zh-CN') + '）；刷新页面会自动恢复。';
      } catch (e) {
        $('savedNote').textContent = '自动保存失败：' + (e && e.message ? e.message : '浏览器拒绝写入本地存储');
      }
    }, 500);
  }
  function restoreFrom(obj, src) {
    if (!obj || !obj.input) { setMessage('没有可恢复的存档。'); return false; }
    fillForm(obj.input);
    setMessage('已从' + src + '恢复' + (obj.savedAt ? '（存档时间 ' + obj.savedAt + '）' : '') + '。');
    run();
    return true;
  }

  // ── 导出 ────────────────────────────────────────────────────
  function csvCell(v) { var s = String(v === null || v === undefined ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
  function row(a) { return a.map(csvCell).join(','); }
  function toCSV(r) {
    var L = [];
    L.push(row(['# 误差传播台 导出', '生成时间 ' + new Date().toISOString()]));
    L.push(row(['# 结果', r.resultName, '公式 ' + r.expr, '单位 ' + (r.resultUnit || '(无)')]));
    L.push(row(['# 结果值', C.fmt(r.f, 10), '一阶不确定度', C.fmt(r.sigmaF, 10), '相对 %', r.relPct === null ? '—' : C.fmt(r.relPct, 6)]));
    L.push('');
    L.push(row(['变量', '数值', '单位', '误差口径', '误差大小', 'σᵢ', '∂f/∂xᵢ', '贡献项', '贡献占比%', '弹性%', '是否参与公式']));
    r.vars.forEach(function (v) {
      L.push(row([v.name, C.fmt(v.value, 10), v.unit, v.mode === 'rel' ? '相对%' : '绝对', C.fmt(v.err, 10), C.fmt(v.sigma, 10),
        C.fmt(v.grad, 10), C.fmt(v.term, 10), C.fmt(v.contributionPct, 6), v.sensitivityPct === null ? '—' : C.fmt(v.sensitivityPct, 6), v.used ? '是' : '否']));
    });
    L.push('');
    L.push(row(['目标口径', '目标数值', '折算后的 σ_target', '当前 σ_f', '是否达标', '等比缩小系数']));
    if (r.target) L.push(row([r.target.mode === 'rel' ? '相对%' : '绝对', C.fmt(r.target.value, 8), C.fmt(r.target.sigmaTarget, 10), C.fmt(r.sigmaF, 10), r.target.feasible ? '已达标' : '未达标', C.fmt(r.target.scaleK, 8)]));
    else L.push(row(['（未设目标）']));
    L.push('');
    L.push(row(['等比缩小：变量', '现在的误差', '需要的误差', '还要收紧%']));
    if (r.target) r.target.rows.forEach(function (x) { L.push(row([x.name, x.currentLabel, x.requiredLabel, x.tightenPct === null ? '—' : C.fmt(x.tightenPct, 4)])); });
    L.push('');
    L.push(row(['只改一个变量：变量', '现在的误差', '需要的误差', '要压紧的倍数', '是否可行', '说明']));
    r.priority.forEach(function (x) {
      L.push(row([x.name, x.currentLabel, x.possible === true ? x.requiredLabel : '—', x.improveFactor ? C.fmt(x.improveFactor, 6) : '—',
        x.possible === true ? '可行' : (x.possible === false ? '做不到' : '未设目标'), x.reason || '']));
    });
    L.push('');
    L.push(row(['蒙特卡洛', '抽样次数', '有效样本', '无效样本', '种子', '均值', '标准差', '最小', '5%', '95%', '最大', '与一阶相差%']));
    L.push(row(['', r.mc.samples, r.mc.used, r.mc.nonFinite, r.mc.seed, C.fmt(r.mc.mean, 10), C.fmt(r.mc.sd, 10),
      C.fmt(r.mc.min, 10), C.fmt(r.mc.p05, 10), C.fmt(r.mc.p95, 10), C.fmt(r.mc.max, 10), r.mc.deviationPct === null ? '—' : C.fmt(r.mc.deviationPct, 6)]));
    L.push('');
    L.push(row(['角点扫描', '顶点数', '最小', '最大', '最小处的取值', '最大处的取值']));
    L.push(row(['', r.corners.count, C.fmt(r.corners.min, 10), C.fmt(r.corners.max, 10), r.corners.minVars.join(' '), r.corners.maxVars.join(' ')]));
    L.push('');
    L.push(row(['建议']));
    r.advice.forEach(function (a) { L.push(row(['[' + a.level + ']', a.text])); });
    L.push('');
    L.push(row(['边界与假设']));
    r.warnings.forEach(function (w) { L.push(row([w])); });
    return '\uFEFF' + L.join('\r\n') + '\r\n';
  }

  function toMD(r) {
    var L = [];
    var p = pair(r.f, r.sigmaF);
    L.push('# 误差传播台 · 结果说明');
    L.push('');
    L.push('生成时间：' + new Date().toISOString());
    L.push('');
    L.push('## 结论');
    L.push('');
    L.push('- ' + r.resultName + ' = **' + p.v + ' ± ' + p.s + (r.resultUnit ? ' ' + r.resultUnit : '') + '**'
      + (r.relPct === null ? '' : '（相对 ±' + C.fmt(r.relPct, 4) + '%）') + '。');
    L.push('- 公式：`' + r.expr + '`；共 ' + r.varCount + ' 个变量，其中 ' + r.usedCount + ' 个参与公式。');
    L.push('- 误差主要来自「' + (r.dominant || '—') + '」' + (r.dominantContributionPct !== null ? '（贡献 ' + C.fmt(r.dominantContributionPct, 4) + '%）' : '') + '。');
    L.push('- 蒙特卡洛（' + r.mc.samples + ' 次，种子 ' + r.mc.seed + '）标准差 ' + C.fmt(r.mc.sd, 6) + '，与一阶传播相差 ' + (r.mc.deviationPct === null ? '—' : C.fmt(r.mc.deviationPct, 4) + '%') + '。');
    L.push('');
    L.push('## 各变量的误差贡献');
    L.push('');
    L.push('| 变量 | 数值 | 误差 | σᵢ | ∂f/∂xᵢ | 贡献项 | 占比 |');
    L.push('|---|---|---|---|---|---|---|');
    r.vars.forEach(function (v) {
      L.push('| ' + v.name + (v.unit ? ' (' + v.unit + ')' : '') + ' | ' + C.fmt(v.value, 8) + ' | ' + v.errLabel + ' | ' + C.fmt(v.sigma, 8)
        + ' | ' + C.fmt(v.grad, 8) + ' | ' + C.fmt(v.term, 8) + ' | ' + C.fmt(v.contributionPct, 4) + '% |');
    });
    L.push('');
    L.push('## 敏感度');
    L.push('');
    L.push('| 变量 | 弹性（变 1% → 结果变 %） | +1σ 时结果变化 |');
    L.push('|---|---|---|');
    r.vars.forEach(function (v) {
      L.push('| ' + v.name + ' | ' + (v.sensitivityPct === null ? '—' : C.fmt(v.sensitivityPct, 4) + '%') + ' | ' + C.fmt(v.term, 8) + ' |');
    });
    L.push('');
    if (r.target) {
      L.push('## 目标精度反推（' + r.target.label + '，' + (r.target.feasible ? '已达标' : '未达标') + '）');
      L.push('');
      L.push('| 变量 | 现在的误差 | 等比缩小后需要的误差 | 还要收紧 |');
      L.push('|---|---|---|---|');
      r.target.rows.forEach(function (x) {
        L.push('| ' + x.name + ' | ' + x.currentLabel + ' | ' + x.requiredLabel + ' | ' + (x.tightenPct === null ? '—' : C.fmt(x.tightenPct, 4) + '%') + ' |');
      });
      L.push('');
    }
    L.push('## 只改一个变量的改进优先级');
    L.push('');
    L.push('| 变量 | 现在的误差 | 需要的误差 | 要压紧的倍数 | 判定 |');
    L.push('|---|---|---|---|---|');
    r.priority.forEach(function (x) {
      L.push('| ' + x.name + ' | ' + x.currentLabel + ' | ' + (x.possible === true ? x.requiredLabel : '—') + ' | '
        + (x.improveFactor ? C.fmt(x.improveFactor, 4) : '—') + ' | ' + (x.possible === true ? '可行' : (x.possible === false ? '做不到' : '未设目标')) + ' |');
    });
    L.push('');
    L.push('## 蒙特卡洛与角点');
    L.push('');
    L.push('| 口径 | 数值 |');
    L.push('|---|---|');
    L.push('| 一阶传播 σ_f | ' + C.fmt(r.sigmaF, 8) + ' |');
    L.push('| 蒙特卡洛标准差 | ' + C.fmt(r.mc.sd, 8) + ' |');
    L.push('| 两者相差 | ' + (r.mc.deviationPct === null ? '—' : C.fmt(r.mc.deviationPct, 4) + '%') + ' |');
    L.push('| 5% – 95% 区间 | ' + C.fmt(r.mc.p05, 8) + ' ~ ' + C.fmt(r.mc.p95, 8) + ' |');
    L.push('| 样本极值 | ' + C.fmt(r.mc.min, 8) + ' ~ ' + C.fmt(r.mc.max, 8) + ' |');
    L.push('| 角点扫描（' + r.corners.count + ' 个顶点） | ' + C.fmt(r.corners.min, 8) + ' ~ ' + C.fmt(r.corners.max, 8) + ' |');
    L.push('');
    L.push('## 建议');
    L.push('');
    r.advice.forEach(function (a) { L.push('- ' + a.text); });
    L.push('');
    L.push('## 边界与假设');
    L.push('');
    r.warnings.forEach(function (w) { L.push('- ' + w); });
    return L.join('\n') + '\n';
  }

  function download(name, text, mime) {
    var blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1500);
  }

  // ── 结果卡 1080×1350 ────────────────────────────────────────
  function drawCard(r) {
    var W = 1080, H = 1350, L = 96, R = W - 96, MAXW = R - L;
    var cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    var x = cv.getContext('2d');
    var FONT = '"PingFang SC",system-ui,-apple-system,sans-serif';
    function setFont(w, size) { x.font = w + ' ' + size + 'px ' + FONT; }
    var NO_START = '）｝】」』》〉、。，；：？！…·)]}%';
    var NO_END = '（｛【「『《〈([{';
    function wrap(text, size, weight, maxLines) {
      setFont(weight, size);
      var out = [], cur = '', i;
      for (i = 0; i < text.length; i++) {
        var ch = text[i], test = cur + ch;
        if (cur && x.measureText(test).width > MAXW) {
          if (NO_START.indexOf(ch) >= 0) { out.push(cur + ch); cur = ''; continue; }
          var carry = '';
          while (cur.length > 1 && NO_END.indexOf(cur.charAt(cur.length - 1)) >= 0) { carry = cur.charAt(cur.length - 1) + carry; cur = cur.slice(0, -1); }
          out.push(cur); cur = carry + ch;
        } else cur = test;
      }
      if (cur) out.push(cur);
      if (out.length > maxLines) {
        out = out.slice(0, maxLines);
        var last = out[maxLines - 1];
        setFont(weight, size);
        while (last.length > 1 && x.measureText(last + '…').width > MAXW) last = last.slice(0, -1);
        out[maxLines - 1] = last + '…';
      }
      return out;
    }
    var y = 128;
    function draw(text, size, weight, color, maxLines, gap) {
      var ls = wrap(String(text), size, weight, maxLines || 1);
      x.fillStyle = color;
      ls.forEach(function (t) { setFont(weight, size); x.fillText(t, L, y); y += (gap || Math.round(size * 1.35)); });
      return ls.length;
    }
    function divider() { x.strokeStyle = '#d9e3ee'; x.lineWidth = 2; x.beginPath(); x.moveTo(L, y); x.lineTo(R, y); x.stroke(); y += 10; }
    function bar(label, p, hot) {
      setFont(650, 24); x.fillStyle = '#22344e'; x.fillText(label, L, y);
      setFont(700, 24); x.fillStyle = hot ? '#a23b28' : '#4a7cb5';
      x.textAlign = 'right'; x.fillText(p + '%', R, y); x.textAlign = 'left';
      y += 14;
      x.fillStyle = '#e8eef7'; x.fillRect(L, y, MAXW, 12);
      var w = Math.max(0, Math.min(1, parseFloat(p) / 100)) * MAXW;
      x.fillStyle = hot ? '#a23b28' : '#4a7cb5'; x.fillRect(L, y, w, 12);
      y += 40;
    }

    x.fillStyle = '#eef3f8'; x.fillRect(0, 0, W, H);
    x.fillStyle = '#ffffff'; x.fillRect(48, 48, W - 96, H - 96);

    var p = pair(r.f, r.sigmaF);
    var u = r.resultUnit ? ' ' + r.resultUnit : '';
    draw('误差传播台 · ERROR PROPAGATION LEDGER', 26, 700, '#2d5f96', 1, 74);
    draw(r.resultName, 40, 700, '#22344e', 1, 52);
    setFont(750, 66); x.fillStyle = '#22344e'; x.fillText(p.v, L, y);
    var w1 = x.measureText(p.v).width;
    setFont(700, 44); x.fillStyle = '#a23b28'; x.fillText('  ± ' + p.s + u, L + w1, y);
    y += 62;
    draw(r.relPct === null ? '结果正好为 0，只报绝对不确定度' : '相对不确定度 ±' + C.fmt(r.relPct, 4) + '%', 27, 700, '#a23b28', 1, 42);
    draw('公式 ' + r.expr + '　·　' + r.varCount + ' 个变量', 23, 400, '#5a6d84', 2, 34);
    y += 6; divider(); y += 30;

    draw('误差贡献（谁的条最长，就先量准谁）', 28, 700, '#22344e', 1, 46);
    var sorted = r.vars.slice().sort(function (a, b) { return b.contributionPct - a.contributionPct; }).slice(0, 4);
    sorted.forEach(function (v) { bar(v.name, C.fmt(v.contributionPct, 3), v.name === r.dominant); });

    y += 4; divider(); y += 30;
    draw('一阶传播 vs 蒙特卡洛', 28, 700, '#22344e', 1, 42);
    draw('一阶 σ_f = ' + C.fmt(r.sigmaF, 6) + '　·　蒙特卡洛 ' + r.mc.samples + ' 次标准差 = ' + C.fmt(r.mc.sd, 6),
      23, 400, '#5a6d84', 2, 32);
    draw('两者相差 ' + (r.mc.deviationPct === null ? '—' : C.fmt(r.mc.deviationPct, 3) + '%') + '　·　角点扫描 ' + r.corners.count + ' 个顶点：'
      + C.fmt(r.corners.min, 5) + ' ~ ' + C.fmt(r.corners.max, 5), 23, 400, '#5a6d84', 2, 32);
    if (r.target) {
      draw((r.target.feasible ? '目标 ' + r.target.label + '：已达标' : '目标 ' + r.target.label + '：未达标，需把误差压到 ' + C.fmt(r.target.scaleK, 4) + ' 倍以内'),
        25, 700, r.target.feasible ? '#2b6b4f' : '#a23b28', 2, 36);
    }
    y += 6; divider(); y += 28;
    draw('下一步', 27, 700, '#22344e', 1, 40);
    var acts = r.advice.filter(function (a) { return a.level === 'act' || a.level === 'key'; }).slice(0, 2);
    acts.forEach(function (a) { draw('· ' + (a.short || a.text), 22, 400, '#22344e', 3, 30); });
    draw('本卡数字与页面同一次计算一致。默认样例与内置场景均为虚构示例，不代表任何真实测量或仪器精度；本页只做误差传播算术，不做量纲检查，也不处理相关误差与系统误差。',
      19, 400, '#718095', 3, 26);
    return cv;
  }

  // ── 事件绑定 ────────────────────────────────────────────────
  function syncFromDom() {
    // 从 DOM 收回当前变量表（输入过程中不重建 DOM，避免光标跳动）
    var items = $('vars').querySelectorAll('.item');
    var out = [];
    Array.prototype.forEach.call(items, function (it) {
      out.push({
        name: it.querySelector('.vname').value,
        value: it.querySelector('.vval').value,
        mode: it.querySelector('.vmode').value,
        err: it.querySelector('.verr').value,
        unit: it.querySelector('.vunit').value
      });
    });
    if (out.length) vars = out;
    expr = $('expr').value;
    resultName = $('resultName').value;
    resultUnit = $('resultUnit').value;
  }

  function boot() {
    fillForm(C.sample);

    // 内置场景按钮
    $('presets').innerHTML = C.presets.map(function (p) {
      return '<button type="button" class="mini preset" data-key="' + esc(p.key) + '">' + esc(p.name) + '</button>';
    }).join('');
    $('mcSamples').innerHTML = C.LIMITS.MC_OPTIONS.map(function (n) {
      return '<option value="' + n + '"' + (n === C.LIMITS.MC_DEFAULT ? ' selected' : '') + '>' + n + ' 次</option>';
    }).join('');

    var saved = null;
    try { saved = localStorage.getItem(STORE); } catch (e) { saved = null; }
    if (saved) { try { restoreFrom(JSON.parse(saved), '本机自动存档'); } catch (e) { } }
    run();

    var panel = $('inputPanel');
    function onEdit(e) {
      if (e.target && (e.target.classList.contains('vname') || e.target.classList.contains('vval') || e.target.classList.contains('verr'))) {
        // 名称/数值/误差变了：先同步状态再重算
        syncFromDom();
      } else {
        syncFromDom();
      }
      run();
    }
    panel.addEventListener('input', onEdit);
    panel.addEventListener('change', onEdit);

    $('vars').addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('.del') : null;
      if (!b) return;
      syncFromDom();
      var i = Number(b.getAttribute('data-del'));
      if (vars.length <= 1) { setMessage('至少要保留一个变量。'); return; }
      vars.splice(i, 1);
      renderVars(); run();
      setMessage('已删除一行变量。');
    });

    $('presets').addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('.preset') : null;
      if (!b) return;
      var key = b.getAttribute('data-key');
      var p = null;
      C.presets.forEach(function (q) { if (q.key === key) p = q; });
      if (!p) return;
      fillForm({ resultName: p.resultName, resultUnit: p.resultUnit, vars: p.vars, expr: p.expr, target: p.target, mcSamples: mcSamples });
      setMessage('已载入虚构场景「' + p.name + '」（数值与误差都是示例，不是真实测量）。');
      run();
    });

    $('addVar').addEventListener('click', function () {
      syncFromDom();
      if (vars.length >= C.LIMITS.MAX_VARS) { setMessage('变量最多 8 个，请把不参与误差分析的常数直接写进公式。'); return; }
      vars = vars.concat([blankVar()]);
      renderVars(); run();
      setMessage('已加一行，填上名称、数值与误差即自动计算。');
    });

    $('demo').addEventListener('click', function () {
      fillForm(C.sample);
      setMessage('已载入虚构示例（装修量房算地板采购面积）。');
      run();
    });

    $('save').addEventListener('click', function () {
      try {
        localStorage.setItem(STORE, JSON.stringify(snapshot()));
        setMessage('已保存到本机（同一浏览器刷新后自动恢复）。');
        $('savedNote').textContent = '已保存到本机。';
      } catch (e) { setMessage('保存失败：' + (e && e.message ? e.message : '浏览器拒绝写入本地存储')); }
    });
    $('restore').addEventListener('click', function () {
      var s = null;
      try { s = localStorage.getItem(STORE); } catch (e) { s = null; }
      if (!s) { setMessage('本机还没有存档，先点「保存到本机」。'); return; }
      try { restoreFrom(JSON.parse(s), '本机存档'); } catch (e) { setMessage('存档解析失败：' + e.message); }
    });
    $('backup').addEventListener('click', function () {
      download('误差传播台-备份.json', JSON.stringify(snapshot(), null, 2), 'application/json');
      setMessage('已下载 JSON 备份。');
    });
    $('import').addEventListener('click', function () { $('imports').click(); });
    $('imports').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      if (!f) return;
      var fr = new FileReader();
      fr.onload = function () {
        try { restoreFrom(JSON.parse(String(fr.result)), '导入的备份文件'); }
        catch (err) { setMessage('导入失败：' + err.message); }
      };
      fr.onerror = function () { setMessage('读取文件失败。'); };
      fr.readAsText(f);
      e.target.value = '';
    });

    $('csv').addEventListener('click', function () { if (!lastSolved) return; download('误差传播-明细.csv', toCSV(lastSolved), 'text/csv;charset=utf-8'); });
    $('md').addEventListener('click', function () { if (!lastSolved) return; download('误差传播-说明.md', toMD(lastSolved), 'text/markdown;charset=utf-8'); });
    $('json').addEventListener('click', function () { download('误差传播台-备份.json', JSON.stringify(snapshot(), null, 2), 'application/json'); });
    $('png').addEventListener('click', function () {
      if (!lastSolved) return;
      var cv = drawCard(lastSolved);
      cv.toBlob(function (b) {
        var url = URL.createObjectURL(b), a = document.createElement('a');
        a.href = url; a.download = '误差传播-结果卡.png';
        document.body.appendChild(a); a.click();
        setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1500);
      }, 'image/png');
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
