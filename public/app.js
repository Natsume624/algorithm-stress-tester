const $ = id => document.getElementById(id);
const html = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

for (const side of ['candidate','oracle']) {
  $(`${side}Mode`).addEventListener('change', e => $(`${side}Fn`).closest('.fn').classList.toggle('hidden', e.target.value !== 'function'));
  $(`${side}File`).addEventListener('change', e => {
    const file = e.target.files[0];
    if (file) $(`${side}Meta`).textContent = `${file.name} · ${(file.size / 1024).toFixed(1)} KB`;
  });
}

$('aiEnabled').addEventListener('change', event => $('aiConfig').classList.toggle('hidden', !event.target.checked));
$('aiProtocol').addEventListener('change', event => {
  const defaults = { openai_responses:'https://api.openai.com/v1', openai_compatible:'http://127.0.0.1:1234/v1', ollama:'http://127.0.0.1:11434' };
  $('aiBaseUrl').value = defaults[event.target.value];
});

function updateMode() {
  const quick = $('verificationMode').value === 'quick';
  $('oracleBox').classList.toggle('hidden', quick);
  $('modeHint').textContent = quick ? '自动推断输入结构并进行确定性、崩溃、超时和可识别性质检查。结果为“未发现问题”，不宣称完全正确。' : '使用独立参考实现逐例比较输出；这是可靠性最高的检验方式。';
}
$('verificationMode').addEventListener('change', updateMode);
updateMode();

async function discoverAI() {
  try {
    const response = await fetch('/api/ai/discover'); const data = await response.json();
    $('aiDiscovery').className = `ai-status ${data.available ? 'ok' : 'warn'}`;
    $('aiDiscovery').textContent = data.available ? `已自动发现：${data.source} · ${data.model}` : '未发现现成模型；仍可使用本地规则，或展开手动配置。';
  } catch { $('aiDiscovery').className = 'ai-status warn'; $('aiDiscovery').textContent = '模型自动检测失败；仍可使用本地规则。'; }
}
discoverAI();

async function source(side) {
  const file = $(`${side}File`).files[0];
  if (!file) throw new Error(side === 'candidate' ? '请选择待测文件' : '请选择参考实现');
  if (file.size > 1024 * 1024) throw new Error(`${file.name} 超过 1 MB`);
  if (!/\.(java|cpp|py)$/i.test(file.name)) throw new Error(`${file.name} 的文件类型不受支持`);
  return { filename: file.name, content: await file.text(), mode: $(`${side}Mode`).value, functionName: $(`${side}Fn`).value };
}

function render(data) {
  const ok = data.failed === 0;
  const quick = data.verification?.mode === 'quick';
  const failures = data.failures.map(f => `<article class="failure"><h3>失败样例 #${f.index}</h3><div class="failure-grid"><div><small>输入</small><pre>${html(f.input)}</pre></div><div><small>待测输出${!f.actual.ok ? '（运行异常）' : ''}</small><pre>${html(f.actual.stdout || f.actual.stderr || (f.actual.timedOut ? '运行超时' : f.actual.error))}</pre></div><div><small>${quick ? '复跑输出 / 性质错误' : '参考输出'}${!f.expected.ok ? '（运行异常）' : ''}</small><pre>${html(f.expected.stderr || f.expected.stdout || (f.expected.timedOut ? '运行超时' : f.expected.error))}</pre></div></div></article>`).join('');
  const c = data.complexity;
  const interpreted = data.interpretation?.length ? `<div class="interpreted"><strong>已按以下要求生成</strong>${data.interpretation.map(x => `<span>${html(x)}</span>`).join('')}</div>` : '';
  const complexity = ok && c ? `<section class="complexity"><div class="complexity-head"><div><small>${c.source === 'AI' ? 'AI ANALYSIS' : 'STATIC ANALYSIS'}</small><h3>复杂度估算</h3></div><span>${html(c.source || '本地规则')} · 置信度：${html(c.confidence)}</span></div><div class="complexity-grid"><div><small>时间复杂度</small><b>${html(c.time)}</b><p>${html(c.timeReason)}</p></div><div><small>额外空间复杂度</small><b>${html(c.space)}</b><p>${html(c.spaceReason)}</p></div></div><p class="complexity-note">${html(c.note)}</p></section>` : '';
  const aiStatus = data.ai?.used ? `<div class="ai-status ok">AI 已使用 ${html(data.ai.model)}，补充 ${data.ai.edgeCases} 个边界样例</div>` : data.ai?.warning ? `<div class="ai-status warn">AI 调用失败，已回退到本地规则：${html(data.ai.warning)}</div>` : '';
  const headline = ok ? (quick ? '未发现问题' : '检验通过') : (quick ? '发现异常' : '发现差异');
  const claim = data.verification?.claim ? `<p class="claim">${html(data.verification.claim)}</p>` : '';
  $('result').innerHTML = `<h2>${headline}</h2>${claim}${aiStatus}${interpreted}<div class="metrics"><div class="metric"><b>${data.executed}</b><span>已执行</span></div><div class="metric"><b>${data.passed}</b><span>通过</span></div><div class="metric"><b>${data.failed}</b><span>失败</span></div><div class="metric"><b>${data.elapsedMs} ms</b><span>总耗时</span></div></div><div class="${ok ? 'pass' : 'fail'}-banner">${ok ? (quick ? `${data.executed} 组输入均可稳定运行并满足已识别性质（种子 ${data.seed}）` : `全部 ${data.executed} 组随机测试结果一致（种子 ${data.seed}）`) : `${data.failed} 组检查失败；下方保留最多 ${data.failures.length} 个样例`}</div>${complexity}${failures}`;
  $('result').classList.remove('hidden'); $('result').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

$('form').addEventListener('submit', async event => {
  event.preventDefault(); const button = $('run'); button.disabled = true; button.querySelector('span').textContent = '正在编译并检验…'; $('result').classList.add('hidden');
  try {
    const payload = {
      mode: $('verificationMode').value,
      candidate: await source('candidate'), oracle: $('verificationMode').value === 'strict' ? await source('oracle') : null,
      generator: { requirement: $('requirement').value, count: +$('count').value, seed: +$('seed').value, min: +$('min').value, max: +$('max').value, minSize: +$('minSize').value, maxSize: +$('maxSize').value },
      ai: { auto: $('aiAuto').checked, enabled: $('aiEnabled').checked, protocol: $('aiProtocol').value, baseUrl: $('aiBaseUrl').value, model: $('aiModel').value, apiKey: $('aiApiKey').value, fallback: $('aiFallback').checked },
      options: { timeoutMs: +$('timeout').value, compareMode: $('compare').value, maxFailures: +$('maxFailures').value, stopOnFirst: $('stop').checked }
    };
    const response = await fetch('/api/run', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(payload) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || '检验失败'); render(data);
  } catch (error) {
    $('result').innerHTML = `<h2>无法完成检验</h2><div class="error">${html(error.message)}</div>`; $('result').classList.remove('hidden'); $('result').scrollIntoView({ behavior:'smooth' });
  } finally { button.disabled = false; button.querySelector('span').textContent = '开始批量检验'; }
});
