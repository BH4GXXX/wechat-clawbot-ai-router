import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeConfig, readConfig } from '../lib/config.mjs';
import { route } from '../lib/engine.mjs';

/**
 * 「任意工具可用 / 不可用」的切换矩阵。
 *
 * 全部使用本地模拟子进程，不联网、不消耗任何 AI 额度，也不产生真实副作用。
 * 重点锁定两件事：
 *   1. 哪些故障**应该**切换（额度/限流/未安装/通道断开）；
 *   2. 哪些情况**必须不切换**（普通任务失败、超时、状态不确定、需要人工确认）。
 */

const node = (name, script, extra = {}) => ({ name, command: process.execPath, args: ['-e', script], ...extra });
const print = (text) => `process.stdout.write(${JSON.stringify(text)})`;
/** 退出码非 0 且 stderr 带指定文本：模拟命令行工具报错。 */
const failWith = (text) => `console.error(${JSON.stringify(text)});process.exitCode=1`;
/** 退出码非 0 且 stdout 是合法 JSON：模拟 output:"json" 型的适配器失败（如豆包适配器）。 */
const jsonFailWith = (text) => `process.stdout.write(JSON.stringify({error:{message:${JSON.stringify(text)}}}));process.exitCode=1`;
/** 执行时留下标记文件，用来证明「备用工具到底有没有被执行」。 */
const marker = (file, text = 'wrong') =>
  `require('node:fs').writeFileSync(${JSON.stringify(file)},'1');process.stdout.write(${JSON.stringify(text)})`;
const newMarker = (t) => {
  const file = join(tmpdir(), `ai-router-marker-${randomUUID()}`);
  t.after(() => rm(file, { force: true }));
  return file;
};
/** 断言某个标记文件不存在，即「该工具没有被执行」。 */
const assertNotRun = (file) => assert.rejects(readFile(file), (e) => e.code === 'ENOENT', '备用工具不应被执行');

async function fixture(t, providers, extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'ai router '));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return normalizeConfig({ stateDir: dir, failoverPolicy: 'safe', providers, ...extra });
}

const tuned = (text, patterns) => ({ output: 'text', retrySafe: true, retryPatterns: patterns });
/**
 * 「工具暂时不可用」类错误的模式表，与 config.json 里给 deepseek / doubao 配的口径一致。
 * 注意：provider 一旦设置 retryPatterns，就会**取代**内置的通用额度正则（见 lib/process.mjs），
 * 所以 429 / 503 / overloaded 这类关键词必须自己列进来，否则只会被当成普通失败。
 */
const QUOTA = [
  'quota', 'usage limit', 'overloaded', 'service unavailable', 'temporarily unavailable',
  'rate.?limit', 'too many requests', '\\b429\\b', '\\b503\\b',
  '额度(?:不足|耗尽|用完)', '限流', '服务暂不可用',
];

test('可用：首选工具正常返回时不打扰任何备用工具', async (t) => {
  const backupMarker = newMarker(t);
  const c = await fixture(t, [node('first', print('ROUTER_OK')), node('second', marker(backupMarker))]);
  const r = await route(c, { prompt: '任务' });
  assert.equal(r.provider, 'first');
  assert.equal(r.text, 'ROUTER_OK');
  assert.deepEqual(r.attempts, []);
  await assertNotRun(backupMarker);
});

test('不可用：额度耗尽（已声明 retrySafe）切换到下一个工具', async (t) => {
  const c = await fixture(t, [
    node('limited', failWith('quota exceeded'), tuned(null, QUOTA)),
    node('backup', print('完成')),
  ]);
  const r = await route(c, { prompt: '任务' });
  assert.equal(r.provider, 'backup');
  assert.deepEqual(r.attempts, [{ provider: 'limited', kind: 'unavailable' }]);
});

test('不可用：限流（429）切换到下一个工具', async (t) => {
  const c = await fixture(t, [
    node('limited', failWith('HTTP 429 Too Many Requests'), tuned(null, QUOTA)),
    node('backup', print('完成')),
  ]);
  assert.equal((await route(c, { prompt: '任务' })).provider, 'backup');
});

test('安全默认：未声明 retrySafe 的文本型工具即使报额度也不切换', async (t) => {
  const backupMarker = newMarker(t);
  const c = await fixture(t, [
    node('limited', failWith('quota exceeded'), { output: 'text' }),
    node('backup', marker(backupMarker)),
  ]);
  await assert.rejects(route(c, { prompt: '任务' }), (e) => e.kind === 'unknown');
  await assertNotRun(backupMarker);
});

test('不可用：工具未安装（ENOENT）切换并记录启动失败', async (t) => {
  const c = await fixture(t, [{ name: 'missing', command: '/not-installed-ai' }, node('backup', print('完成'))]);
  const r = await route(c, { prompt: '任务' });
  assert.equal(r.provider, 'backup');
  assert.deepEqual(r.attempts, [{ provider: 'missing', kind: 'start_failed' }]);
});

test('不可用：豆包 CDP 未开启（output:json）切换到下一个工具', async (t) => {
  const c = await fixture(t, [
    node('doubao', jsonFailWith('豆包适配器调用失败（退出码 1）：Doubao CDP is unavailable at http://127.0.0.1:9225. Run "doubao --app doubao cdp launch" to enable CDP.'), {
      output: 'json',
      retrySafe: true,
      retryPatterns: ['CDP is unavailable', ...QUOTA],
    }),
    node('deepseek', print('完成')),
  ]);
  const r = await route(c, { prompt: '任务' });
  assert.equal(r.provider, 'deepseek');
  assert.deepEqual(r.attempts, [{ provider: 'doubao', kind: 'unavailable' }]);
});

test('不可用：工具没装（找不到 doubao 命令）也切换', async (t) => {
  const c = await fixture(t, [
    node('doubao', jsonFailWith('豆包适配器：找不到 doubao 命令。请安装 doubao-cli，或用 DOUBAO_CLI 指定绝对路径。'), {
      output: 'json',
      retrySafe: true,
      retryPatterns: ['找不到 doubao 命令', ...QUOTA],
    }),
    node('deepseek', print('完成')),
  ]);
  assert.equal((await route(c, { prompt: '任务' })).provider, 'deepseek');
});

test('不切换：普通任务失败（与额度无关）', async (t) => {
  const backupMarker = newMarker(t);
  const c = await fixture(t, [
    node('bad', failWith('输入不合法，无法完成该任务'), tuned(null, QUOTA)),
    node('backup', marker(backupMarker)),
  ]);
  await assert.rejects(route(c, { prompt: '任务' }), (e) => e.kind === 'unknown' && /电脑端/.test(e.message));
  await assertNotRun(backupMarker);
});

test('不切换：豆包状态不确定（避免重复副作用）', async (t) => {
  const backupMarker = newMarker(t);
  const c = await fixture(t, [
    node('doubao', jsonFailWith('豆包任务状态未知，请勿重复提交：无输出'), { output: 'json', retrySafe: true, retryPatterns: ['CDP is unavailable', ...QUOTA] }),
    node('backup', marker(backupMarker)),
  ]);
  await assert.rejects(route(c, { prompt: '任务' }), (e) => e.kind === 'unknown');
  await assertNotRun(backupMarker);
});

test('不切换：豆包需要人工确认（权限类）', async (t) => {
  const backupMarker = newMarker(t);
  const c = await fixture(t, [
    node('doubao', jsonFailWith('豆包任务需要人工确认，请在电脑端豆包处理后再提交新任务。'), { output: 'json', retrySafe: true, retryPatterns: ['CDP is unavailable', ...QUOTA] }),
    node('backup', marker(backupMarker)),
  ]);
  await assert.rejects(route(c, { prompt: '任务' }), (e) => e.kind === 'unknown');
  await assertNotRun(backupMarker);
});

test('不切换：超时后备用工具不执行（执行状态不确定）', async (t) => {
  const backupMarker = newMarker(t);
  const c = await fixture(t, [
    node('slow', 'setInterval(()=>{},1000)', { timeoutSeconds: 0.05 }),
    node('backup', marker(backupMarker)),
  ]);
  await assert.rejects(route(c, { prompt: '任务' }), (e) => e.kind === 'timeout');
  await assertNotRun(backupMarker);
});

test('可切换：结构化 CLI 空闲且未执行工具时切换备用工具', async (t) => {
  const event = JSON.stringify({ type: 'thread.started', thread_id: 'offline-thread' }) + '\n';
  const c = await fixture(t, [
    node('offline-codex', `${print(event)};setInterval(()=>{},1000)`, { output: 'codex-jsonl', idleTimeoutSeconds: 0.05, timeoutSeconds: 1 }),
    node('backup', print('完成')),
  ]);
  const r = await route(c, { prompt: '任务' });
  assert.equal(r.provider, 'backup');
  assert.deepEqual(r.attempts, [{ provider: 'offline-codex', kind: 'unavailable' }]);
});

test('不切换：结构化 CLI 空闲前已经执行工具', async (t) => {
  const backupMarker = newMarker(t);
  const events = [
    { type: 'thread.started', thread_id: 'active-thread' },
    { type: 'item.started', item: { type: 'command_execution' } },
  ].map(x => JSON.stringify(x)).join('\n') + '\n';
  const c = await fixture(t, [
    node('active-codex', `${print(events)};setInterval(()=>{},1000)`, { output: 'codex-jsonl', idleTimeoutSeconds: 0.05, timeoutSeconds: 1 }),
    node('backup', marker(backupMarker)),
  ]);
  await assert.rejects(route(c, { prompt: '任务' }), (e) => e.kind === 'timeout');
  await assertNotRun(backupMarker);
});

test('可用性优先：普通失败也继续下一个工具', async (t) => {
  const c = await fixture(t, [
    node('failed', failWith('任务执行失败')),
    node('backup', print('完成')),
  ], { failoverPolicy: 'availability-first' });
  const r = await route(c, { prompt: '任务' });
  assert.equal(r.provider, 'backup');
  assert.deepEqual(r.attempts, [{ provider: 'failed', kind: 'unknown' }]);
});

test('可用性优先：即使超时且执行状态不确定也继续下一个工具', async (t) => {
  const c = await fixture(t, [
    node('slow', 'setInterval(()=>{},1000)', { timeoutSeconds: 0.05 }),
    node('backup', print('完成')),
  ], { failoverPolicy: 'availability-first' });
  const r = await route(c, { prompt: '任务' });
  assert.equal(r.provider, 'backup');
  assert.deepEqual(r.attempts, [{ provider: 'slow', kind: 'timeout' }]);
});

test('不可用：全部候选都不可用时给出明确原因', async (t) => {
  const c = await fixture(t, [
    node('first', failWith('quota exceeded'), tuned(null, QUOTA)),
    node('second', failWith('rate limit exceeded'), tuned(null, QUOTA)),
  ]);
  await assert.rejects(route(c, { prompt: '任务' }), (e) => e.kind === 'unavailable' && /电脑端/.test(e.message));
});

test('冷却：故障工具在冷却期内被整体跳过，不再重复尝试', async (t) => {
  const c = await fixture(t, [
    node('limited', failWith('quota exceeded'), tuned(null, QUOTA)),
    node('backup', print('完成')),
  ]);
  const first = await route(c, { id: 'cool-1', prompt: '任务' });
  assert.equal(first.provider, 'backup');
  assert.equal(first.attempts.length, 1);

  const second = await route(c, { id: 'cool-2', prompt: '任务' });
  assert.equal(second.provider, 'backup');
  assert.deepEqual(second.attempts, [], '冷却中的工具应被跳过，而不是再次失败');
});

test('不可用：三个工具依次失败后由最后一个成功接管', async (t) => {
  const c = await fixture(t, [
    node('a', failWith('quota exceeded'), tuned(null, QUOTA)),
    node('b', failWith('HTTP 503 Service Unavailable'), tuned(null, QUOTA)),
    node('c', print('ROUTER_OK')),
  ]);
  const r = await route(c, { prompt: '任务' });
  assert.equal(r.provider, 'c');
  assert.deepEqual(r.attempts, [
    { provider: 'a', kind: 'unavailable' },
    { provider: 'b', kind: 'unavailable' },
  ]);
});

test('项目配置：文本/JSON 型工具都声明了可安全重试（否则切换永远不生效）', async (t) => {
  const file = new URL('../config.json', import.meta.url);
  if (!existsSync(file)) return t.skip('本机没有 config.json（该文件不入版本库）');
  const config = await readConfig(file.pathname);
  for (const name of ['deepseek', 'workbuddy', 'doubao']) {
    const p = config.providers.find((x) => x.name === name);
    assert.ok(p, `${name} 未在 config.json 中配置`);
    assert.notEqual(p.output, 'codex-jsonl');
    assert.equal(p.retrySafe, true, `${name} 缺少 retrySafe:true，故障时不会切换`);
    assert.ok(p.retryPatterns.length, `${name} 缺少 retryPatterns`);
  }
});
