const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { parseRequirement, generateCases, normalize, languageOf, analyzeComplexity, parseModelJson, requestAiAnalysis, stress } = require('../server');

test('detects supported languages', () => {
  assert.equal(languageOf('Main.java'), 'java'); assert.equal(languageOf('a.cpp'), 'cpp'); assert.equal(languageOf('x.py'), 'python'); assert.equal(languageOf('x.js'), undefined);
});

test('generation is deterministic and bounded', () => {
  const a = generateCases({ preset:'int_array', count:20, seed:42, min:-2, max:2, minSize:0, maxSize:5 });
  const b = generateCases({ preset:'int_array', count:20, seed:42, min:-2, max:2, minSize:0, maxSize:5 });
  assert.deepEqual(a, b); assert.equal(a.length, 20);
});

test('generates the maximum batch of 10,000 valid cases', () => {
  const cases = generateCases({ preset:'matrix', count:10000, seed:99, min:-10, max:10, minSize:1, maxSize:4 });
  assert.equal(cases.length, 10000);
  for (const input of cases) {
    const lines = input.trim().split('\n');
    const [rows, cols] = lines[0].split(/\s+/).map(Number);
    assert.equal(lines.length, rows + 1);
    assert.ok(lines.slice(1).every(line => line.trim().split(/\s+/).length === cols));
  }
});

test('understands adjacent unequal integer-array requirements', () => {
  const requirement = '生成长度 5 到 20、元素范围 [-3,3]、相邻两项不相等的整数数组';
  const parsed = parseRequirement(requirement, { count: 500, seed: 123 });
  assert.equal(parsed.preset, 'int_array'); assert.equal(parsed.min, -3); assert.equal(parsed.max, 3); assert.equal(parsed.adjacentUnequal, true);
  for (const input of generateCases(parsed)) {
    const tokens = input.trim().split(/\s+/).map(Number), n = tokens[0], values = tokens.slice(1);
    assert.equal(values.length, n); assert.ok(n >= 5 && n <= 20);
    assert.ok(values.every(x => x >= -3 && x <= 3));
    assert.ok(values.every((x, i) => i === 0 || x !== values[i - 1]));
  }
});

test('understands combined natural-language constraints', () => {
  const parsed = parseRequirement('长度为 8，元素是 1 到 99 的互不相同奇数，严格递增的整数数组', { count: 50 });
  const cases = generateCases(parsed);
  assert.equal(parsed.min, 1); assert.equal(parsed.max, 99); assert.equal(parsed.odd, true);
  for (const input of cases) {
    const values = input.trim().split(/\s+/).map(Number).slice(1);
    assert.equal(new Set(values).size, 8);
    assert.ok(values.every(x => x % 2 !== 0));
    assert.ok(values.every((x, i) => i === 0 || x > values[i - 1]));
  }
});

test('rejects impossible natural-language constraints', () => {
  assert.throws(() => generateCases({ requirement:'长度为 3，元素范围 [1,1]，相邻两项不相等的整数数组' }), /无法满足/);
});

test('parses fenced model JSON safely', () => {
  assert.deepEqual(parseModelJson('```json\n{"edgeCases":["1\\n"]}\n```'), { edgeCases:['1\n'] });
  assert.throws(() => parseModelJson('not json'), /没有返回/);
});

test('calls an OpenAI-compatible local model endpoint', async () => {
  let received;
  const mock = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    received = { url:req.url, auth:req.headers.authorization, body:JSON.parse(Buffer.concat(chunks)) };
    const content = JSON.stringify({ generator:{preset:'int_array',min:0,max:9,minSize:2,maxSize:4}, edgeCases:['2\n0 1\n'], interpretation:['AI整数数组'], complexity:{time:'O(n)',space:'O(1)',confidence:'高'} });
    res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify({choices:[{message:{content}}]}));
  });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  try {
    const port = mock.address().port;
    const result = await requestAiAnalysis({protocol:'openai_compatible',baseUrl:`http://127.0.0.1:${port}/v1`,model:'local-test',apiKey:'secret'}, '整数数组', {filename:'a.py',content:'print(1)'});
    assert.equal(received.url, '/v1/chat/completions'); assert.equal(received.auth, 'Bearer secret');
    assert.equal(received.body.model, 'local-test'); assert.equal(result.edgeCases.length, 1); assert.equal(result.complexity.time, 'O(n)');
  } finally { await new Promise(resolve => mock.close(resolve)); }
});

test('comparison modes work', () => {
  assert.equal(normalize('1  2\n', 'tokens'), normalize('1\n2', 'tokens'));
  assert.notEqual(normalize('1 2', 'exact'), normalize('1\n2', 'exact'));
});

test('estimates common time and extra-space complexities', () => {
  const sorted = analyzeComplexity({ filename:'a.py', content:'def solve(a):\n    return sorted(a)\n' });
  assert.equal(sorted.time, 'O(n log n)'); assert.equal(sorted.space, 'O(n)');
  const nested = analyzeComplexity({ filename:'a.java', content:'class A { void f(){ for(int i=0;i<n;i++){ for(int j=0;j<n;j++){} } } }' });
  assert.equal(nested.time, 'O(n²)');
  const graph = analyzeComplexity({ filename:'a.cpp', content:'vector<vector<int>> adj; queue<int> queue; vector<int> visited; void bfs(){}' });
  assert.equal(graph.time, 'O(n + m)'); assert.equal(graph.space, 'O(n + m)');
});

test('python stress run finds a wrong algorithm', async () => {
  const oracle = `import sys\na=list(map(int,sys.stdin.read().split()))[1:]\nprint(*sorted(a))\n`;
  const candidate = `import sys\na=list(map(int,sys.stdin.read().split()))[1:]\nprint(*a)\n`;
  const result = await stress({ candidate:{filename:'bad.py',content:candidate}, oracle:{filename:'ok.py',content:oracle}, generator:{preset:'int_array',count:30,seed:7,min:-9,max:9,minSize:3,maxSize:8}, options:{compareMode:'tokens',timeoutMs:2000,maxFailures:3} });
  assert.ok(result.failed > 0); assert.equal(result.failures.length, 3);
});

test('python function mode ignores top-level comparator', async () => {
  const code = `def solve(data):\n a=list(map(int,data.split()))[1:]\n return ' '.join(map(str,sorted(a)))\nraise RuntimeError('this comparator must be ignored')\n`;
  const result = await stress({ candidate:{filename:'a.py',content:code,mode:'function'}, oracle:{filename:'b.py',content:code,mode:'function'}, generator:{preset:'int_array',count:5,seed:2,min:0,max:9,minSize:2,maxSize:4}, options:{compareMode:'tokens'} });
  assert.equal(result.failed, 0); assert.equal(result.complexity.time, 'O(n log n)');
});

test('C++ function mode ignores uploaded main', async () => {
  const code = `#include <bits/stdc++.h>\nusing namespace std;\nstring solve(const string& in){istringstream s(in);int n,x;s>>n;vector<int>a(n);for(int&i:a)s>>i;sort(a.begin(),a.end());ostringstream o;for(int i:a)o<<i<<' ';return o.str();}\nint main(){return 99;}\n`;
  const result = await stress({ candidate:{filename:'a.cpp',content:code,mode:'function'}, oracle:{filename:'b.cpp',content:code,mode:'function'}, generator:{preset:'int_array',count:8,seed:3,min:-5,max:5,minSize:0,maxSize:5}, options:{compareMode:'tokens'} });
  assert.equal(result.failed, 0);
});

test('Java function mode ignores uploaded main', async () => {
  const code = `import java.util.*; public class Main { public static String solve(String in){Scanner s=new Scanner(in);int n=s.nextInt();int[] a=new int[n];for(int i=0;i<n;i++)a[i]=s.nextInt();Arrays.sort(a);StringBuilder b=new StringBuilder();for(int x:a)b.append(x).append(' ');return b.toString();} public static void main(String[] x){throw new RuntimeException("ignored");} }`;
  const result = await stress({ candidate:{filename:'Main.java',content:code,mode:'function'}, oracle:{filename:'Main.java',content:code,mode:'function'}, generator:{preset:'int_array',count:5,seed:4,min:-5,max:5,minSize:0,maxSize:5}, options:{compareMode:'tokens',timeoutMs:3000} });
  assert.equal(result.failed, 0);
});

test('runs 1,000 real C++ differential cases', { timeout: 60000 }, async () => {
  const code = `#include <bits/stdc++.h>\nusing namespace std;int main(){ios::sync_with_stdio(false);cin.tie(nullptr);int n;cin>>n;vector<int>a(n);for(int&i:a)cin>>i;sort(a.begin(),a.end());for(int x:a)cout<<x<<' ';}`;
  const result = await stress({ candidate:{filename:'fast.cpp',content:code}, oracle:{filename:'direct.cpp',content:code}, generator:{preset:'int_array',count:1000,seed:20260914,min:-100000,max:100000,minSize:0,maxSize:100}, options:{compareMode:'tokens',timeoutMs:2000} });
  assert.equal(result.executed, 1000); assert.equal(result.passed, 1000); assert.equal(result.failed, 0);
});
