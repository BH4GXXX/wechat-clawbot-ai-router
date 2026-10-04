#!/usr/bin/env node
/**
 * 豆包桌面端适配器（对应 T04 / T10）
 *
 * 路由器把任务写到 stdin，并要求 stdout 返回 JSON（provider.output = "json"）。
 * 本适配器用 doubao-cli 驱动本机已登录的豆包，取出 reply.text 交给路由器。
 *
 * 前置条件：
 *   1. 豆包桌面端已安装并登录；
 *   2. 已执行 `doubao cdp launch` 开启本地调试端口。
 *      豆包每次正常重启后端口都会关闭，需要在调用前重新开启。
 *
 * 本文件不手工运行，由 config.json 的 provider 调用：
 *   node adapters/doubao.mjs [透传给 doubao sessions create 的额外参数...]
 *
 * 环境变量：
 *   DOUBAO_CLI                    doubao 可执行文件路径，默认从 PATH 查找
 *   DOUBAO_ADAPTER_BUDGET_MS      单次任务总等待预算，默认 240000
 *   DOUBAO_ADAPTER_SLICE_SECONDS  单次等待秒数，默认 110
 *   DOUBAO_ADAPTER_MAX_BYTES      任务文本字节上限，默认 524288（命令行长度保护）
 */
import { spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, resolve } from 'node:path';

const BUDGET_MS = positiveInt(process.env.DOUBAO_ADAPTER_BUDGET_MS, 240000);
const SLICE_SECONDS = positiveInt(process.env.DOUBAO_ADAPTER_SLICE_SECONDS, 110);
const MAX_BYTES = positiveInt(process.env.DOUBAO_ADAPTER_MAX_BYTES, 512 * 1024);
const passthrough = process.argv.slice(2);

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}
function fail(message) {
  process.stderr.write(message.endsWith('\n') ? message : `${message}\n`);
  // 路由器在 output:"json" 下会先解析 stdout、再看退出码。失败时 stdout 若为空，
  // 会被误判为「AI 返回的 JSON 无效」，因此失败也必须输出一个合法的 JSON 对象。
  process.stdout.write(`${JSON.stringify({ error: { message } })}\n`);
  process.exit(1);
}
// doubao 的会话消息只能通过命令行位置参数传入，因此需要显式给出可执行文件。
function resolveCli() {
  const explicit = process.env.DOUBAO_CLI;
  if (explicit) {
    try {
      return statSync(explicit).isFile() ? explicit : null;
    } catch {
      return null;
    }
  }
  for (const directory of (process.env.PATH || '').split(delimiter)) {
    if (!directory) continue;
    const file = resolve(directory, 'doubao');
    try {
      accessSync(file, constants.X_OK);
      if (statSync(file).isFile()) return file;
    } catch {}
  }
  return null;
}
async function readStdin() {
  let data = '';
  // 先完整读完再判断长度：提前退出会让上游写 stdin 失败，任务会被记为「状态不确定」。
  for await (const part of process.stdin) data += part;
  return data;
}
function run(cli, args) {
  return new Promise((settle) => {
    const child = spawn(cli, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (Buffer.byteLength(out) < 4 * 1024 * 1024) out += chunk;
    });
    child.stderr.on('data', (chunk) => {
      err = (err + chunk).slice(-16384);
    });
    child.on('error', (error) => settle({ code: -1, out, err: error.message }));
    child.on('close', (code) => settle({ code, out, err }));
  });
}
function parseJson(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}
function describe(result, parsed) {
  const tail = (text) => (text || '').trim().slice(-600);
  if (parsed?.status === 'waiting_input') {
    return '豆包任务需要人工确认，请在电脑端豆包处理后再提交新任务。无人值守场景请使用 --runtime cloud，或把 --permission 设为 FullAccess。';
  }
  if (parsed?.status === 'cancelled') return '豆包任务已被取消。';
  if (parsed?.status === 'failed') return `豆包任务执行失败：${tail(result.err) || tail(result.out) || '豆包未返回原因'}`;
  if (parsed?.status === 'unknown') return `豆包任务状态未知，请勿重复提交：${tail(result.err) || tail(result.out) || '无输出'}`;
  if (parsed?.status === 'running') {
    return `豆包任务在 ${BUDGET_MS / 1000} 秒内未完成（runId=${parsed.runId}）。任务可能仍在豆包侧继续，请先检查后再决定是否重做。`;
  }
  return `豆包适配器调用失败（退出码 ${result.code}）：${tail(result.err) || tail(result.out) || '无输出'}。若提示 CDP 不可用，请先在电脑端执行 doubao cdp launch。`;
}

const cli = resolveCli();
if (!cli) fail('豆包适配器：找不到 doubao 命令。请安装 doubao-cli，或用 DOUBAO_CLI 指定绝对路径（例如 ~/.local/bin/doubao）。');

const prompt = (await readStdin()).trim();
if (!prompt) fail('豆包适配器：未收到任务内容。');
const bytes = Buffer.byteLength(prompt);
if (bytes > MAX_BYTES) {
  fail(`豆包适配器：任务内容 ${bytes} 字节，超过本地命令行长度上限 ${MAX_BYTES} 字节，已停止，未发出任何消息。`);
}

let args = ['sessions', 'create', '--wait', '--timeout', String(SLICE_SECONDS), '--json', ...passthrough, '--', prompt];
const deadline = Date.now() + BUDGET_MS;
for (;;) {
  const result = await run(cli, args);
  const parsed = parseJson(result.out);
  if (parsed?.status === 'completed') {
    const text = typeof parsed.reply?.text === 'string' ? parsed.reply.text.trim() : '';
    if (!text) fail(`豆包适配器：任务显示已完成，但没有取到回复文本（conversationId=${parsed.conversationId}）。`);
    process.stdout.write(`${JSON.stringify({ text, nativeTaskId: parsed.conversationId, runId: parsed.runId })}\n`);
    process.exit(0);
  }
  // --wait 只等到单次超时；任务仍在跑时按同一 runId 续等，不重发消息。
  if (parsed?.status === 'running' && parsed.conversationId && parsed.runId && Date.now() < deadline) {
    args = ['sessions', 'wait', String(parsed.conversationId), '--run', String(parsed.runId), '--timeout', String(SLICE_SECONDS), '--json'];
    continue;
  }
  fail(describe(result, parsed));
}
