import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ADAPTER = join(dirname(fileURLToPath(import.meta.url)), '..', 'adapters', 'doubao.mjs');

// 模拟 doubao CLI：把收到的参数追加到日志，并按场景返回结果。全程不联网、不消耗额度。
const fakeCli = `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
if (process.env.FAKE_DAO_LOG) appendFileSync(process.env.FAKE_DAO_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
const [group, action] = process.argv.slice(2);
const mode = process.env.FAKE_DAO_MODE || 'completed';
const reply = (text) => JSON.stringify({ conversationId: '38445393965860610', runId: '57379913800295170', status: 'completed', reply: { role: 'assistant', text } });
if (mode === 'completed') { process.stdout.write(reply('ROUTER_OK')); process.exit(0); }
if (mode === 'resume' && action === 'create') { process.stdout.write(JSON.stringify({ conversationId: '38445393965860610', runId: '57379913800295170', status: 'running', reply: null })); process.exit(1); }
if (mode === 'resume' && action === 'wait') { process.stdout.write(reply('续等成功')); process.exit(0); }
if (mode === 'waiting_input') { process.stdout.write(JSON.stringify({ status: 'waiting_input', pending: [] })); process.exit(1); }
if (mode === 'cdp') { process.stderr.write('doubao: Doubao CDP is unavailable at http://127.0.0.1:9225. Run "doubao --app doubao cdp launch" to enable CDP.\\n'); process.exit(1); }
process.exit(1);
`;

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'doubao adapter '));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cli = join(dir, 'doubao.mjs');
  await writeFile(cli, fakeCli);
  await chmod(cli, 0o755);
  const log = join(dir, 'argv.log');
  return { cli, log };
}
function runAdapter(cli, extra = {}, { input = '只回复 ROUTER_OK', args = [], env = {} } = {}) {
  return new Promise((settle) => {
    const child = spawn(process.execPath, [ADAPTER, ...args], {
      env: { ...process.env, DOUBAO_CLI: cli, ...extra, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('close', (code) => settle({ code, out, err }));
    child.stdin.end(input);
  });
}

test('成功时输出路由器可解析的 {"text":...}，并把任务作为位置参数放在 -- 之后', async (t) => {
  const { cli, log } = await setup(t);
  const result = await runAdapter(cli, { FAKE_DAO_MODE: 'completed', FAKE_DAO_LOG: log }, { args: ['--runtime', 'cloud'] });
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.out), { text: 'ROUTER_OK', nativeTaskId: '38445393965860610', runId: '57379913800295170' });
  const argv = JSON.parse((await readFile(log, 'utf8')).trim().split('\n')[0]);
  assert.deepEqual(argv, ['sessions', 'create', '--wait', '--timeout', argv[argv.indexOf('--timeout') + 1], '--json', '--runtime', 'cloud', '--', '只回复 ROUTER_OK']);
});

test('--wait 只等到单次超时时，按同一 runId 续等且不重发消息', async (t) => {
  const { cli, log } = await setup(t);
  const result = await runAdapter(cli, { FAKE_DAO_MODE: 'resume', FAKE_DAO_LOG: log, DOUBAO_ADAPTER_SLICE_SECONDS: '5' });
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.out), { text: '续等成功', nativeTaskId: '38445393965860610', runId: '57379913800295170' });
  const calls = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].slice(0, 2), ['sessions', 'create']);
  assert.deepEqual(calls[1].slice(0, 4), ['sessions', 'wait', '38445393965860610', '--run']);
  assert.equal(calls[1].includes('57379913800295170'), true);
});

test('CDP 未开启时失败，但 stdout 仍是合法 JSON（否则路由器会误报「JSON 无效」）', async (t) => {
  const { cli } = await setup(t);
  const result = await runAdapter(cli, { FAKE_DAO_MODE: 'cdp' });
  assert.equal(result.code, 1);
  const payload = JSON.parse(result.out);
  assert.match(payload.error.message, /CDP is unavailable/);
  assert.match(payload.error.message, /cdp launch/);
  assert.match(result.err, /CDP is unavailable/);
});

test('需要人工确认时明确提示，不误判为完成', async (t) => {
  const { cli } = await setup(t);
  const result = await runAdapter(cli, { FAKE_DAO_MODE: 'waiting_input' });
  assert.equal(result.code, 1);
  assert.match(JSON.parse(result.out).error.message, /人工确认/);
});

test('找不到 doubao 命令时给出可操作的提示', async (t) => {
  const { cli } = await setup(t);
  const result = await runAdapter(join(cli, '..', 'not-installed'), { PATH: '' });
  assert.equal(result.code, 1);
  assert.match(JSON.parse(result.out).error.message, /DOUBAO_CLI/);
});

test('任务超过命令行长度上限时直接失败，且不调用豆包', async (t) => {
  const { cli, log } = await setup(t);
  const result = await runAdapter(cli, { FAKE_DAO_LOG: log, DOUBAO_ADAPTER_MAX_BYTES: '64' }, { input: 'x'.repeat(500) });
  assert.equal(result.code, 1);
  assert.match(JSON.parse(result.out).error.message, /字节/);
  await assert.rejects(readFile(log, 'utf8'), (error) => error.code === 'ENOENT');
});
