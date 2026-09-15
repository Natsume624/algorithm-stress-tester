'use strict';

const http = require('http');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT || 3210);
const PUBLIC = path.join(__dirname, 'public');
const MAX_BODY = 2 * 1024 * 1024;

class UserError extends Error {}

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new UserError('请求过大（上限 2 MB）');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new UserError('请求 JSON 无效'); }
}

function safeName(name, fallback) {
  const value = path.basename(String(name || fallback)).replace(/[^\w.-]/g, '_');
  return value || fallback;
}

function languageOf(filename) {
  const ext = path.extname(filename).toLowerCase();
  return ({ '.py': 'python', '.cpp': 'cpp', '.java': 'java' })[ext];
}

function xorshift(seed) {
  let state = (Number(seed) || 1) >>> 0;
  return () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

function intBetween(random, a, b) {
  return a + Math.floor(random() * (b - a + 1));
}

function numberOr(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseRequirement(requirement = '', base = {}) {
  const text = String(requirement || '').trim();
  let preset = base.preset || 'int_array';
  if (/字符串/.test(text)) preset = 'lowercase_string';
  else if (/矩阵|二维数组/.test(text)) preset = 'matrix';
  else if (/(?:两个|两组|2个).*(?:整数数组|数组)/.test(text)) preset = 'two_int_arrays';
  else if (/(?:两个|一对|2个).*整数/.test(text) && !/数组/.test(text)) preset = 'integer_pair';
  else if (/单个整数|一个整数/.test(text)) preset = 'integer';
  else if (/数组|序列/.test(text)) preset = 'int_array';

  let min = numberOr(base.min, 0), max = numberOr(base.max, 100);
  let minSize = numberOr(base.minSize, 1), maxSize = numberOr(base.maxSize, 30);
  const valueRange = text.match(/(?:元素|数值|取值|数字)(?:的)?(?:范围)?\s*(?:为|是|：|:|在)?\s*[\[（(]?\s*(-?\d+)\s*(?:,|，|到|至|~|～)\s*(-?\d+)/) || text.match(/[\[（(]\s*(-?\d+)\s*[,，]\s*(-?\d+)\s*[\]）)]/);
  if (valueRange) { min = Number(valueRange[1]); max = Number(valueRange[2]); }
  const lengthRange = text.match(/(?:长度|规模|元素个数|字符数)\s*(?:范围)?\s*(?:为|是|：|:|在)?\s*[\[（(]?\s*(\d+)\s*(?:,|，|到|至|~|～|-)\s*(\d+)/);
  const exactLength = text.match(/(?:长度|规模|元素个数|字符数)\s*(?:为|是|=|：|:)?\s*(\d+)\s*(?:个)?(?:\s|，|,|、|$)/);
  const maxLength = text.match(/(?:长度|规模|元素个数|字符数|n)\s*(?:不超过|至多|小于等于|<=|≤)\s*(\d+)/i);
  const minLength = text.match(/(?:长度|规模|元素个数|字符数|n)\s*(?:不少于|至少|大于等于|>=|≥)\s*(\d+)/i);
  if (lengthRange) { minSize = Number(lengthRange[1]); maxSize = Number(lengthRange[2]); }
  else if (exactLength) minSize = maxSize = Number(exactLength[1]);
  else { if (maxLength) maxSize = Number(maxLength[1]); if (minLength) minSize = Number(minLength[1]); }

  const adjacentUnequal = /相邻(?:两|2)?(?:项|个|元素|字符)?.{0,5}(?:不相等|不同|不重复|不等)/.test(text);
  const unique = /互不相同|各不相同|元素唯一|没有重复|无重复/.test(text) || (!/相邻/.test(text) && /不重复/.test(text));
  const strictAscending = /严格递增/.test(text), strictDescending = /严格递减/.test(text);
  const ascending = strictAscending || /非递减|不下降|升序|从小到大|单调递增/.test(text);
  const descending = strictDescending || /非递增|不上升|降序|从大到小|单调递减/.test(text);
  const nonnegative = /非负整数|不小于\s*0/.test(text);
  const positive = !nonnegative && /正整数/.test(text);
  const negative = /负整数/.test(text) && !/非负整数/.test(text);
  const even = /偶数/.test(text), odd = /奇数/.test(text);
  if (positive) min = Math.max(1, min);
  if (nonnegative) min = Math.max(0, min);
  if (negative) max = Math.min(-1, max);
  if (even && odd) throw new UserError('数据要求冲突：不能同时要求所有元素都是奇数和偶数');
  if (ascending && descending && maxSize > 1) throw new UserError('数据要求冲突：不能同时要求递增和递减');
  if (min > max) throw new UserError(`数据要求无法满足：数值下界 ${min} 大于上界 ${max}`);
  if (minSize < 0 || minSize > maxSize) throw new UserError('数据要求无法满足：长度范围无效');

  const typeName = ({ integer:'单个整数', integer_pair:'两个整数', int_array:'整数数组', two_int_arrays:'两个整数数组', matrix:'整数矩阵', lowercase_string:'小写字符串' })[preset];
  const interpretation = [typeName, `规模 ${minSize}～${maxSize}`, preset === 'lowercase_string' ? '字符 a～z' : `数值 ${min}～${max}`];
  if (adjacentUnequal) interpretation.push('相邻两项不相等');
  if (unique) interpretation.push('所有元素互不相同');
  if (strictAscending) interpretation.push('严格递增'); else if (ascending) interpretation.push('非递减排列');
  if (strictDescending) interpretation.push('严格递减'); else if (descending) interpretation.push('非递增排列');
  if (positive) interpretation.push('仅正整数'); if (nonnegative) interpretation.push('仅非负整数'); if (negative) interpretation.push('仅负整数');
  if (even) interpretation.push('仅偶数'); if (odd) interpretation.push('仅奇数');
  return { ...base, preset, min, max, minSize, maxSize, adjacentUnequal, unique, ascending, descending, strictAscending, strictDescending, even, odd, interpretation, _resolved: true };
}

function generateCases(config = {}) {
  config = config._resolved ? config : parseRequirement(config.requirement, config);
  const count = Math.max(1, Math.min(10000, Number(config.count) || 200));
  const min = Math.max(-1e9, Math.min(1e9, numberOr(config.min, 0)));
  const max = Math.max(min, Math.min(1e9, numberOr(config.max, 100)));
  const minSize = Math.max(0, Math.min(10000, numberOr(config.minSize, 1)));
  const maxSize = Math.max(minSize, Math.min(10000, numberOr(config.maxSize, 30)));
  const random = xorshift(config.seed);
  const preset = config.preset || 'int_array';
  const cases = [];
  const step = config.even || config.odd ? 2 : 1;
  let first = min;
  if (config.even && Math.abs(first % 2) === 1) first++;
  if (config.odd && Math.abs(first % 2) !== 1) first++;
  const domain = first > max ? 0 : Math.floor((max - first) / step) + 1;
  const values = n => {
    const distinct = config.unique || config.strictAscending || config.strictDescending || ((config.ascending || config.descending) && config.adjacentUnequal);
    if (n && domain === 0) throw new UserError('数据要求无法满足：指定范围内没有符合奇偶要求的整数');
    if (distinct && n > domain) throw new UserError(`数据要求无法满足：需要 ${n} 个不同值，但范围内只有 ${domain} 个可用值`);
    if (config.adjacentUnequal && n > 1 && domain < 2) throw new UserError('数据要求无法满足：只有一个可用值，无法保证相邻两项不相等');
    const result = [], used = new Set();
    for (let i = 0; i < n; i++) {
      let index = intBetween(random, 0, domain - 1), attempts = 0;
      while ((distinct && used.has(index)) || (config.adjacentUnequal && i && result[i - 1] === first + index * step)) {
        index = (index + 1) % domain;
        if (++attempts > domain + 2) throw new UserError('数据要求无法满足，请扩大取值范围');
      }
      used.add(index); result.push(first + index * step);
    }
    if (config.ascending) result.sort((a,b) => a-b);
    if (config.descending) result.sort((a,b) => b-a);
    return result;
  };
  for (let i = 0; i < count; i++) {
    if (preset === 'integer') cases.push(`${values(1)[0]}\n`);
    else if (preset === 'integer_pair') cases.push(`${values(2).join(' ')}\n`);
    else if (preset === 'int_array') {
      const n = intBetween(random, minSize, maxSize), a = values(n);
      cases.push(`${n}\n${a.join(' ')}\n`);
    } else if (preset === 'two_int_arrays') {
      const n = intBetween(random, minSize, maxSize), m = intBetween(random, minSize, maxSize);
      cases.push(`${n}\n${values(n).join(' ')}\n${m}\n${values(m).join(' ')}\n`);
    } else if (preset === 'matrix') {
      const rows = intBetween(random, Math.max(1, minSize), Math.max(1, maxSize));
      const cols = intBetween(random, Math.max(1, minSize), Math.max(1, maxSize));
      const flat = values(rows * cols);
      const lines = Array.from({ length: rows }, (_, row) => flat.slice(row * cols, (row + 1) * cols).join(' '));
      cases.push(`${rows} ${cols}\n${lines.join('\n')}\n`);
    } else if (preset === 'lowercase_string') {
      const n = intBetween(random, minSize, maxSize);
      if (config.unique && n > 26) throw new UserError('数据要求无法满足：小写字母只有 26 个，不能生成更长的不重复字符串');
      let s = '', used = new Set();
      for (let j = 0; j < n; j++) {
        let code = intBetween(random, 0, 25);
        while ((config.unique && used.has(code)) || (config.adjacentUnequal && j && s.charCodeAt(j - 1) - 97 === code)) code = (code + 1) % 26;
        used.add(code); s += String.fromCharCode(97 + code);
      }
      if (config.ascending) s = [...s].sort().join('');
      if (config.descending) s = [...s].sort().reverse().join('');
      cases.push(`${n}\n${s}\n`);
    } else throw new UserError('未知数据模板');
  }
  return cases;
}

function normalize(text, mode) {
  const clean = String(text).replace(/\r\n/g, '\n');
  if (mode === 'exact') return clean;
  if (mode === 'tokens') return clean.trim().split(/\s+/).filter(Boolean).join(' ');
  return clean.split('\n').map(x => x.trimEnd()).join('\n').trim();
}

function stripComments(source, language) {
  if (language === 'python') return source.replace(/#.*$/gm, '');
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function pythonLoopDepth(source) {
  const stack = [];
  let max = 0;
  for (const raw of source.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const indent = raw.match(/^[ \t]*/)[0].replace(/\t/g, '    ').length;
    while (stack.length && indent <= stack[stack.length - 1]) stack.pop();
    if (/^\s*(for|while)\b/.test(raw)) {
      stack.push(indent); max = Math.max(max, stack.length);
    }
  }
  return max;
}

function cStyleLoopDepth(source) {
  const tokens = source.match(/\b(?:for|while)\b|[{}]/g) || [];
  const scopes = [];
  let pending = false, depth = 0, max = 0;
  for (const token of tokens) {
    if (token === 'for' || token === 'while') pending = true;
    else if (token === '{') {
      scopes.push(pending); if (pending) { depth++; max = Math.max(max, depth); }
      pending = false;
    } else if (token === '}') {
      if (scopes.pop()) depth--;
      pending = false;
    }
  }
  return max;
}

function analyzeComplexity(spec = {}) {
  const language = languageOf(spec.filename || '') || 'python';
  const source = stripComments(String(spec.content || ''), language);
  const loopDepth = language === 'python' ? pythonLoopDepth(source) : cStyleLoopDepth(source);
  const hasSort = /\b(?:sorted|sort|Arrays\.sort|Collections\.sort)\s*\(/.test(source);
  const hasBinarySearch = /\b(?:binarySearch|lower_bound|upper_bound|bisect(?:_left|_right)?)\b/.test(source) || (/\bmid\b/.test(source) && /(?:left|low|lo)\s*<=?\s*(?:right|high|hi)/.test(source));
  const hasGraph = /\b(?:adj(?:acency)?|neighbors?|edges?)\b/i.test(source) && /\b(?:visited|queue|deque|dfs|bfs)\b/i.test(source);
  const hasMemo = /\b(?:memo|cache|lru_cache|dp)\b/i.test(source);
  const functionNames = [...source.matchAll(language === 'python' ? /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/gm : /\b(?:static\s+)?[\w<>\[\], ?&:*]+\s+([A-Za-z_]\w*)\s*\([^;{}]*\)\s*\{/g)].map(m => m[1]);
  const recursive = functionNames.find(name => (source.match(new RegExp(`\\b${name}\\s*\\(`, 'g')) || []).length > 1);

  let time = 'O(1)', timeReason = '未识别到随输入规模增长的循环、排序或递归';
  let confidence = '中';
  if (hasGraph) { time = 'O(n + m)'; timeReason = '检测到邻接结构以及 BFS/DFS 的队列或访问标记'; confidence = '中'; }
  else if (loopDepth >= 3) { time = `O(n^${loopDepth})`; timeReason = `检测到 ${loopDepth} 层循环嵌套`; confidence = '中'; }
  else if (loopDepth === 2) { time = 'O(n²)'; timeReason = '检测到两层循环嵌套'; confidence = '中'; }
  else if (hasSort) { time = 'O(n log n)'; timeReason = '检测到标准排序调用'; confidence = '高'; }
  else if (hasBinarySearch) { time = 'O(log n)'; timeReason = '检测到二分搜索结构'; confidence = '中'; }
  else if (recursive && hasMemo) { time = 'O(n)～O(n²)'; timeReason = `检测到带记忆化的递归函数 ${recursive}，精确上界取决于状态数与转移数`; confidence = '低'; }
  else if (recursive) { time = 'O(2ⁿ)（保守估算）'; timeReason = `检测到递归函数 ${recursive}，但无法静态确认分支数与剪枝`; confidence = '低'; }
  else if (loopDepth === 1) { time = 'O(n)'; timeReason = '检测到一层随输入遍历的循环'; confidence = '中'; }

  const has2d = /vector\s*<\s*vector|new\s+\w+\s*\[[^\]]+\]\s*\[[^\]]+\]|\[\s*\[[^\]]*\][^\n]*\bfor\b/.test(source);
  const hasDynamic = /\b(?:vector|ArrayList|LinkedList|HashMap|HashSet|TreeMap|TreeSet|dict|list|set|deque|Counter)\b/.test(source) || /\[[^\]]*\]\s*(?:\*|for\b)/.test(source);
  let space = 'O(1)', spaceReason = '未识别到随输入规模增长的额外容器或递归栈';
  if (hasGraph) { space = 'O(n + m)'; spaceReason = '邻接结构和访问标记随顶点、边数量增长'; }
  else if (has2d) { space = 'O(n²)'; spaceReason = '检测到二维动态结构'; }
  else if (hasDynamic || (recursive && hasMemo)) { space = 'O(n)'; spaceReason = '检测到随输入增长的动态容器或记忆化状态'; }
  else if (recursive) { space = 'O(n)'; spaceReason = '递归调用栈深度按最坏线性规模估算'; }
  else if (hasSort && language === 'python') { space = 'O(n)'; spaceReason = 'Python sorted 会创建与输入规模同阶的新列表'; }
  else if (hasSort && language === 'cpp') { space = 'O(log n)'; spaceReason = 'C++ 标准内省排序通常使用对数级调用栈'; }
  else if (hasSort && language === 'java') { space = 'O(log n)～O(n)'; spaceReason = 'Java 排序的额外空间取决于元素类型和具体重载'; confidence = '低'; }

  return { time, space, confidence, timeReason, spaceReason, note: 'n 表示主要输入规模，m 表示图的边数；结果来自静态特征估算，不等同于形式化证明。' };
}

function parseModelJson(text) {
  const raw = String(text || '').replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim();
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new UserError('大模型没有返回可解析的 JSON');
  try { return JSON.parse(raw.slice(start, end + 1)); }
  catch { throw new UserError('大模型返回的 JSON 格式无效'); }
}

function apiUrl(base, suffix) {
  const value = String(base || '').trim().replace(/\/+$/, '');
  let parsed;
  try { parsed = new URL(value); } catch { throw new UserError('大模型 API 地址无效'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new UserError('大模型 API 地址仅支持 http 或 https');
  return value.endsWith(suffix) ? value : value + suffix;
}

async function requestAiAnalysis(ai, requirement, candidate) {
  const protocol = ai.protocol || 'openai_compatible';
  const model = String(ai.model || '').trim();
  if (!model) throw new UserError('启用 AI 后必须填写模型名称');
  const prompt = `你是算法对数器的数据设计与复杂度分析模块。\n用户的数据要求（可能为空，请结合源码推断）：${requirement}\n待测文件：${candidate.filename}\n源码：\n${String(candidate.content || '').slice(0, 60000)}\n\n只返回一个 JSON 对象，不要 Markdown。结构：{"generator":{"preset":"int_array|two_int_arrays|matrix|lowercase_string|integer|integer_pair","min":整数,"max":整数,"minSize":整数,"maxSize":整数,"adjacentUnequal":布尔,"unique":布尔,"ascending":布尔,"descending":布尔,"even":布尔,"odd":布尔},"edgeCases":["完整的stdin输入字符串，最多20项"],"interpretation":["简短中文规则"],"properties":["sorted_permutation|nonnegative_number|output_from_input"],"complexity":{"time":"大O表示","space":"额外空间大O表示","confidence":"高|中|低","timeReason":"中文依据","spaceReason":"中文依据","note":"局限说明"}}。properties 只能从给定枚举中选择，无法确定就返回空数组。edgeCases 必须严格符合推断的程序输入格式；复杂度只分析算法实现，忽略对数器和测试代码。`;
  const headers = { 'content-type': 'application/json' };
  if (ai.apiKey) headers.authorization = `Bearer ${ai.apiKey}`;
  let url, payload, extract;
  if (protocol === 'openai_responses') {
    url = apiUrl(ai.baseUrl, '/responses');
    payload = { model, instructions: 'Return valid JSON only.', input: prompt, store: false, max_output_tokens: 4000 };
    extract = data => data.output_text || data.output?.flatMap(item => item.content || []).find(item => item.type === 'output_text')?.text;
  } else if (protocol === 'ollama') {
    url = apiUrl(ai.baseUrl, '/api/chat');
    payload = { model, stream: false, format: 'json', messages: [{ role:'user', content:prompt }] };
    extract = data => data.message?.content;
  } else {
    url = apiUrl(ai.baseUrl, '/chat/completions');
    payload = { model, temperature: 0.1, messages: [{ role:'system', content:'Return valid JSON only.' }, { role:'user', content:prompt }] };
    extract = data => data.choices?.[0]?.message?.content;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  let response;
  try { response = await fetch(url, { method:'POST', headers, body:JSON.stringify(payload), signal:controller.signal }); }
  catch (error) { throw new UserError(error.name === 'AbortError' ? '大模型请求超过 60 秒' : `无法连接大模型：${error.message}`); }
  finally { clearTimeout(timer); }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new UserError(`大模型 API 返回 ${response.status}：${data.error?.message || data.message || '请求失败'}`);
  const result = parseModelJson(extract(data));
  const edgeCases = Array.isArray(result.edgeCases) ? result.edgeCases.filter(x => typeof x === 'string' && x.length <= 100000).slice(0, 20) : [];
  const generator = result.generator && typeof result.generator === 'object' ? result.generator : {};
  const complexity = result.complexity && typeof result.complexity === 'object' ? result.complexity : null;
  const allowedProperties = ['sorted_permutation','nonnegative_number','output_from_input'];
  const properties = Array.isArray(result.properties) ? result.properties.filter(x => allowedProperties.includes(x)) : [];
  return { generator, edgeCases, interpretation: Array.isArray(result.interpretation) ? result.interpretation.map(String).slice(0, 12) : [], properties, complexity, model, protocol };
}

function inferRequirementFromSource(candidate = {}) {
  const source = String(candidate.content || '');
  if (/\b(?:sort|sorted|Arrays\.sort|Collections\.sort)\s*\(/.test(source)) return '整数数组；算法疑似排序，输出为排序后的全部元素';
  if (/\b(?:gcd|最大公约数)\b/i.test(source)) return '两个整数';
  if (/\b(?:matrix|grid|二维|rows?|cols?)\b/i.test(source)) return '整数矩阵';
  if (/\b(?:string|String|str)\b/.test(source) && !/vector\s*<\s*int|int\s*\[/.test(source)) return '小写字符串';
  return '整数数组';
}

async function probeJson(url, timeoutMs = 700) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal:controller.signal });
    if (!response.ok) return null;
    return await response.json();
  } catch { return null; } finally { clearTimeout(timer); }
}

async function discoverAiConfig() {
  if (process.env.OPENAI_MODEL && (process.env.OPENAI_API_KEY || process.env.OPENAI_BASE_URL)) {
    return { available:true, source:'环境变量', protocol:'openai_responses', baseUrl:process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1', model:process.env.OPENAI_MODEL, apiKey:process.env.OPENAI_API_KEY || '' };
  }
  const ollama = await probeJson('http://127.0.0.1:11434/api/tags');
  const ollamaModel = ollama?.models?.[0]?.name;
  if (ollamaModel) return { available:true, source:'Ollama', protocol:'ollama', baseUrl:'http://127.0.0.1:11434', model:ollamaModel, apiKey:'' };
  for (const port of [1234, 8000]) {
    const compatible = await probeJson(`http://127.0.0.1:${port}/v1/models`);
    const model = compatible?.data?.[0]?.id;
    if (model) return { available:true, source:port === 1234 ? 'LM Studio' : '本地OpenAI-compatible', protocol:'openai_compatible', baseUrl:`http://127.0.0.1:${port}/v1`, model, apiKey:'' };
  }
  return { available:false, source:null };
}

async function resolveAiConfig(ai = {}) {
  if (ai.enabled && ai.model && ai.baseUrl) return { ...ai, available:true, source:'手动配置' };
  if (ai.auto) return discoverAiConfig();
  return { available:false };
}

function inferProperties(candidate = {}) {
  const source = String(candidate.content || '');
  const properties = [];
  if (/\b(?:sort|sorted|Arrays\.sort|Collections\.sort)\s*\(/.test(source)) properties.push('sorted_permutation');
  if (/\b(?:abs|Math\.abs|fabs)\s*\(/.test(source)) properties.push('nonnegative_number');
  return properties;
}

function validateProperties(input, output, properties) {
  const failures = [];
  const inputNumbers = String(input).trim().split(/\s+/).map(Number);
  const outputTokens = String(output).trim().split(/\s+/).filter(Boolean);
  if (properties.includes('sorted_permutation')) {
    const n = inputNumbers[0], values = inputNumbers.slice(1, n + 1), actual = outputTokens.map(Number);
    const expected = [...values].sort((a,b) => a-b);
    if (actual.length !== expected.length || actual.some((x,i) => x !== expected[i])) failures.push('输出不是输入元素的非递减排列');
  }
  if (properties.includes('nonnegative_number')) {
    const value = Number(outputTokens[0]); if (!Number.isFinite(value) || value < 0) failures.push('输出不是非负数');
  }
  if (properties.includes('output_from_input')) {
    const values = new Set(inputNumbers.slice(1).map(String)); if (outputTokens.some(x => !values.has(x))) failures.push('输出包含输入中不存在的值');
  }
  return failures;
}

function runProcess(command, args, options = {}) {
  return new Promise(resolve => {
    const started = Date.now();
    const child = spawn(command, args, { cwd: options.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false, outputOverflow = false;
    const cap = 1024 * 1024;
    const collect = key => data => {
      if ((key === 'out' ? stdout : stderr).length + data.length > cap) {
        outputOverflow = true; child.kill(); return;
      }
      if (key === 'out') stdout += data.toString(); else stderr += data.toString();
    };
    child.stdout.on('data', collect('out')); child.stderr.on('data', collect('err'));
    child.on('error', error => resolve({ ok: false, error: error.message, stdout, stderr, ms: Date.now() - started }));
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, options.timeoutMs || 2000);
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && !timedOut && !outputOverflow, code, stdout, stderr, timedOut, outputOverflow, ms: Date.now() - started });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(options.input || '');
  });
}

function javaClassName(content, filename) {
  const found = content.match(/public\s+(?:final\s+)?class\s+([A-Za-z_$][\w$]*)/) || content.match(/class\s+([A-Za-z_$][\w$]*)/);
  return found ? found[1] : path.basename(filename, '.java');
}

async function prepareProgram(spec, root, label) {
  const filename = safeName(spec.filename, `${label}.py`);
  const language = languageOf(filename);
  if (!language) throw new UserError(`${label} 仅支持 .java、.cpp、.py`);
  if (!spec.content || typeof spec.content !== 'string') throw new UserError(`${label} 文件为空`);
  const dir = path.join(root, label);
  await fs.mkdir(dir, { recursive: true });
  let sourceName = filename;
  if (language === 'java') sourceName = `${javaClassName(spec.content, filename)}.java`;
  const source = path.join(dir, sourceName);
  await fs.writeFile(source, spec.content, 'utf8');
  const mode = spec.mode === 'function' ? 'function' : 'program';
  const fn = String(spec.functionName || 'solve');

  if (!/^[A-Za-z_$][\w$]*$/.test(fn)) throw new UserError('算法函数名无效');
  if (language === 'python') {
    if (mode === 'program') return { command: 'python', args: [source], cwd: dir, language };
    const runner = path.join(dir, '__runner__.py');
    const wrapper = `import ast, sys\np=${JSON.stringify(source)}\nsrc=open(p,encoding='utf-8').read()\nt=ast.parse(src,p)\nkeep=[]\nfor n in t.body:\n    if isinstance(n,(ast.Import,ast.ImportFrom,ast.FunctionDef,ast.AsyncFunctionDef,ast.ClassDef)):\n        keep.append(n)\n    elif isinstance(n,(ast.Assign,ast.AnnAssign)):\n        v=n.value\n        if v is None or isinstance(v,(ast.Constant,ast.List,ast.Tuple,ast.Set,ast.Dict)):\n            keep.append(n)\nt.body=keep\nns={'__name__':'__candidate__','__file__':p}\nexec(compile(t,p,'exec'),ns)\nr=ns[${JSON.stringify(fn)}](sys.stdin.read())\nif r is not None: sys.stdout.write(str(r))\n`;
    await fs.writeFile(runner, wrapper, 'utf8');
    return { command: 'python', args: [runner], cwd: dir, language };
  }

  if (language === 'cpp') {
    const exe = path.join(dir, 'program.exe');
    let result;
    if (mode === 'program') {
      result = await runProcess('g++', ['-std=c++17', '-O2', source, '-o', exe], { cwd: dir, timeoutMs: 20000 });
    } else {
      const object = path.join(dir, 'candidate.o');
      result = await runProcess('g++', ['-std=c++17', '-O2', '-Dmain=__uploaded_main_ignored', '-c', source, '-o', object], { cwd: dir, timeoutMs: 20000 });
      if (result.ok) {
        const runner = path.join(dir, '__runner__.cpp');
        const wrapper = `#include <iostream>\n#include <sstream>\n#include <string>\nstd::string ${fn}(const std::string&);\nint main(){std::ostringstream s;s<<std::cin.rdbuf();std::cout<<${fn}(s.str());}\n`;
        await fs.writeFile(runner, wrapper, 'utf8');
        result = await runProcess('g++', ['-std=c++17', '-O2', runner, object, '-o', exe], { cwd: dir, timeoutMs: 20000 });
      }
    }
    if (!result.ok) throw new UserError(`${label} C++ 编译失败\n${result.stderr || result.error || ''}`);
    return { command: exe, args: [], cwd: dir, language };
  }

  const cls = javaClassName(spec.content, filename);
  let mainClass = cls;
  if (mode === 'function') {
    mainClass = '__Runner__';
    const runner = path.join(dir, '__Runner__.java');
    const wrapper = `import java.nio.charset.StandardCharsets;\npublic class __Runner__ { public static void main(String[] a) throws Exception { String in=new String(System.in.readAllBytes(),StandardCharsets.UTF_8); Object out=${cls}.${fn}(in); if(out!=null) System.out.print(out); } }\n`;
    await fs.writeFile(runner, wrapper, 'utf8');
  }
  const javaFiles = mode === 'function' ? [source, path.join(dir, '__Runner__.java')] : [source];
  const compiled = await runProcess('javac', ['-encoding', 'UTF-8', ...javaFiles], { cwd: dir, timeoutMs: 20000 });
  if (!compiled.ok) throw new UserError(`${label} Java 编译失败\n${compiled.stderr || compiled.error || ''}`);
  return { command: 'java', args: ['-cp', dir, mainClass], cwd: dir, language };
}

async function stress(body) {
  const quickMode = body.mode === 'quick' || (!body.mode && !body.oracle?.content);
  if (!quickMode && !body.oracle?.content) throw new UserError('严格模式必须上传参考实现');
  const requirement = String(body.generator?.requirement || '').trim() || inferRequirementFromSource(body.candidate);
  let generator = parseRequirement(requirement, body.generator || {});
  let aiResult = null, aiWarning = null;
  let resolvedAi = { available:false };
  if (body.ai?.enabled || body.ai?.auto) {
    try {
      resolvedAi = await resolveAiConfig(body.ai);
      if (!resolvedAi.available) throw new UserError('未发现已配置的云端模型、Ollama、LM Studio或vLLM');
      aiResult = await requestAiAnalysis(resolvedAi, requirement, body.candidate || {});
      const plan = aiResult.generator;
      const allowed = ['int_array','two_int_arrays','matrix','lowercase_string','integer','integer_pair'];
      generator = {
        ...generator,
        preset: allowed.includes(plan.preset) ? plan.preset : generator.preset,
        min: Number.isFinite(Number(plan.min)) ? Number(plan.min) : generator.min,
        max: Number.isFinite(Number(plan.max)) ? Number(plan.max) : generator.max,
        minSize: Number.isFinite(Number(plan.minSize)) ? Number(plan.minSize) : generator.minSize,
        maxSize: Number.isFinite(Number(plan.maxSize)) ? Number(plan.maxSize) : generator.maxSize,
        adjacentUnequal: typeof plan.adjacentUnequal === 'boolean' ? plan.adjacentUnequal : generator.adjacentUnequal,
        unique: typeof plan.unique === 'boolean' ? plan.unique : generator.unique,
        ascending: typeof plan.ascending === 'boolean' ? plan.ascending : generator.ascending,
        descending: typeof plan.descending === 'boolean' ? plan.descending : generator.descending,
        even: typeof plan.even === 'boolean' ? plan.even : generator.even,
        odd: typeof plan.odd === 'boolean' ? plan.odd : generator.odd,
        interpretation: aiResult.interpretation.length ? aiResult.interpretation : generator.interpretation,
        _resolved: true
      };
      if (generator.min > generator.max || generator.minSize > generator.maxSize) throw new UserError('大模型生成了无效的数值或规模范围');
      if (generator.even && generator.odd) throw new UserError('大模型生成了冲突规则：同时要求奇数和偶数');
      if (generator.ascending && generator.descending && generator.maxSize > 1) throw new UserError('大模型生成了冲突规则：同时要求递增和递减');
    } catch (error) {
      if (!body.ai.fallback) throw error;
      aiWarning = error.message;
    }
  }
  const requestedCount = Math.max(1, Math.min(10000, Number(body.generator?.count) || 200));
  const aiCases = aiResult ? aiResult.edgeCases.slice(0, requestedCount) : [];
  const randomCount = requestedCount - aiCases.length;
  const cases = [...aiCases, ...(randomCount ? generateCases({ ...generator, count: randomCount }) : [])];
  const timeoutMs = Math.max(100, Math.min(10000, Number(body.options?.timeoutMs) || 2000));
  const maxFailures = Math.max(1, Math.min(20, Number(body.options?.maxFailures) || 5));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'algo-check-'));
  const started = Date.now();
  try {
    const candidate = await prepareProgram(body.candidate || {}, root, 'candidate');
    const oracle = quickMode ? null : await prepareProgram(body.oracle || {}, root, 'oracle');
    const properties = [...new Set([...inferProperties(body.candidate), ...(aiResult?.properties || [])])];
    const failures = [];
    let passed = 0, candidateMs = 0, oracleMs = 0;
    for (let index = 0; index < cases.length; index++) {
      const input = cases[index];
      const [actual, comparison] = await Promise.all([
        runProcess(candidate.command, candidate.args, { cwd: candidate.cwd, input, timeoutMs }),
        runProcess((oracle || candidate).command, (oracle || candidate).args, { cwd:(oracle || candidate).cwd, input, timeoutMs })
      ]);
      const propertyErrors = quickMode && actual.ok ? validateProperties(input, actual.stdout, properties) : [];
      const expected = quickMode ? { ...comparison, stderr: propertyErrors.join('；'), quick:true } : comparison;
      candidateMs += actual.ms; oracleMs += expected.ms;
      const same = actual.ok && expected.ok && propertyErrors.length === 0 && normalize(actual.stdout, body.options?.compareMode) === normalize(expected.stdout, body.options?.compareMode);
      if (same) passed++;
      else if (failures.length < maxFailures) failures.push({ index: index + 1, input, actual, expected });
      if (!same && body.options?.stopOnFirst) break;
    }
    const executed = body.options?.stopOnFirst && failures.length ? passed + 1 : cases.length;
    const failed = executed - passed;
    const staticComplexity = analyzeComplexity(body.candidate);
    const aiComplexity = aiResult?.complexity;
    const complexity = failed === 0 ? (aiComplexity && aiComplexity.time && aiComplexity.space ? {
      time: String(aiComplexity.time), space: String(aiComplexity.space), confidence: String(aiComplexity.confidence || '中'),
      timeReason: String(aiComplexity.timeReason || '由大模型基于源码分析'), spaceReason: String(aiComplexity.spaceReason || '由大模型基于源码分析'),
      note: String(aiComplexity.note || '大模型分析并非形式化证明，请结合代码人工复核。'), source: 'AI'
    } : { ...staticComplexity, source:'本地规则' }) : null;
    return { total: executed, requested: cases.length, executed, passed, failed, failures, candidateMs, oracleMs, elapsedMs: Date.now() - started, seed: Number(body.generator?.seed) || 1, interpretation: generator.interpretation, complexity, verification: { mode:quickMode ? 'quick' : 'strict', properties, claim:quickMode ? '完成确定性、运行安全与可识别性质检查；未发现问题不等同于证明算法正确。' : '候选算法与独立参考实现逐例输出一致。' }, ai: { enabled: !!(body.ai?.enabled || body.ai?.auto), used: !!aiResult, source:resolvedAi.source || null, model: aiResult?.model || null, protocol: aiResult?.protocol || null, edgeCases: aiCases.length, warning: aiWarning } };
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const target = path.resolve(PUBLIC, relative);
  if (!target.startsWith(PUBLIC)) return json(res, 404, { error: 'Not found' });
  try {
    const data = await fs.readFile(target);
    const type = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' }[path.extname(target)] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'content-length': data.length }); res.end(data);
  } catch { json(res, 404, { error: 'Not found' }); }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/api/health') return json(res, 200, { ok: true, languages: ['java', 'cpp', 'python'] });
    if (req.method === 'GET' && req.url === '/api/ai/discover') {
      const found = await discoverAiConfig();
      return json(res, 200, { available:found.available, source:found.source || null, protocol:found.protocol || null, baseUrl:found.baseUrl || null, model:found.model || null });
    }
    if (req.method === 'POST' && req.url === '/api/run') return json(res, 200, await stress(await readJson(req)));
    if (req.method === 'GET') return serveStatic(req, res);
    json(res, 405, { error: 'Method not allowed' });
  } catch (error) {
    json(res, error instanceof UserError ? 400 : 500, { error: error.message || '内部错误' });
  }
});

if (require.main === module) server.listen(PORT, '127.0.0.1', () => console.log(`算法对数器已启动：http://127.0.0.1:${PORT}`));
module.exports = { parseRequirement, generateCases, normalize, languageOf, analyzeComplexity, parseModelJson, requestAiAnalysis, inferRequirementFromSource, inferProperties, validateProperties, discoverAiConfig, stress, server };
