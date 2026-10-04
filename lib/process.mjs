import { spawn } from 'node:child_process';
import { launchCommand } from './config.mjs';

export class Failure extends Error {
  constructor(message, kind = 'task_failed', retryable = false) { super(message); this.kind = kind; this.retryable = retryable; }
}
const unavailable = /rate.?limit|too many requests|quota|usage limit|overloaded|service unavailable|temporarily unavailable|unauthorized|authentication failed|not logged in|\b429\b|\b503\b|额度(?:不足|耗尽|用完)|限流|服务暂不可用/iu;
function inspectStructuredProgress(p, stdout) {
  if (!p.output.endsWith('jsonl')) return null;
  let toolUsed = false;
  for (const line of stdout.split(/\r?\n/).filter(x => x.trim())) {
    let event;
    try { event = JSON.parse(line); } catch { return null; }
    if (p.output === 'codex-jsonl') {
      if (event.type?.startsWith('item.') && event.item && !['agent_message','reasoning'].includes(event.item.type)) toolUsed = true;
    } else if (event.type === 'assistant' && event.message?.content?.some(x => x.type === 'tool_use')) toolUsed = true;
  }
  return { toolUsed };
}
function parseResultDetails(p, stdout, stderr, code) {
  let text = stdout.trim(), errorText = stderr, failed = code !== 0, toolUsed = false, complete = false, reliable = false;
  let nativeTaskId;
  if (p.output.endsWith('jsonl')) {
    let events;
    try { events = stdout.split(/\r?\n/).filter(x => x.trim()).map(x => JSON.parse(x)); } catch { throw new Failure('AI 返回的事件格式无效', 'invalid_output'); }
    const replies = []; reliable = events.length > 0;
    for (const event of events) {
      if (p.output === 'codex-jsonl') {
        if (event.type === 'thread.started' && typeof event.thread_id === 'string') nativeTaskId = event.thread_id;
        if (event.type?.startsWith('item.') && event.item && !['agent_message','reasoning'].includes(event.item.type)) toolUsed = true;
        if (event.type === 'item.completed' && event.item?.type === 'agent_message') replies.push(event.item.text);
        if (event.type === 'turn.completed') complete = true;
        if (['error','turn.failed'].includes(event.type)) { failed = true; errorText += '\n' + (event.error?.message || event.message || 'AI 执行失败'); }
      } else {
        if (typeof event.session_id === 'string') nativeTaskId = event.session_id;
        if (event.type === 'assistant' && event.message?.content?.some(x => x.type === 'tool_use')) toolUsed = true;
        if (event.type === 'result') {
          complete = true; failed ||= event.is_error === true || (event.subtype && event.subtype !== 'success');
          if (event.is_error || (event.subtype && event.subtype !== 'success')) errorText += '\n' + (event.errors?.join('\n') || event.result || event.subtype);
          else replies.push(event.result || '');
          if (event.permission_denials?.length) throw new Failure('AI 工具需要权限确认，请在电脑端处理。', 'permission_required');
        }
      }
    }
    text = replies.filter(Boolean).join('\n');
    if (!failed && !complete) throw new Failure('AI 未返回完成事件，执行状态不确定。', 'unknown');
  } else if (p.output === 'json') {
    let obj;
    try { obj = JSON.parse(stdout); } catch { throw new Failure('AI 返回的 JSON 无效', 'invalid_output'); }
    failed ||= obj?.is_error === true;
    if (failed) errorText += '\n' + (obj?.error?.message || obj?.result || '');
    text = typeof obj === 'string' ? obj : ['result','response','text','content'].map(k => obj?.[k]).find(v => typeof v === 'string');
    if (obj && typeof obj === 'object') nativeTaskId = ['nativeTaskId','sessionId','conversationId','runId'].map(k => obj[k]).find(v => typeof v === 'string');
  }
  if (failed) {
    const message = errorText || stdout;
    const matches = p.retryPatterns.length ? p.retryPatterns.some(x => new RegExp(x,'iu').test(message)) : unavailable.test(message);
    // Structured tool events prevent replay after local tools have already run.
    const retryable = matches && (p.retrySafe || (reliable && !toolUsed));
    throw new Failure(matches ? 'AI 额度、登录或服务暂不可用' : 'AI 执行失败，请在电脑端检查该工具。', retryable ? 'unavailable' : 'unknown', retryable);
  }
  if (typeof text !== 'string' || !text.trim()) throw new Failure('AI 未返回有效结果', 'invalid_output');
  return { text:text.trim(), nativeTaskId };
}
export function parseResult(p, stdout, stderr, code) { return parseResultDetails(p,stdout,stderr,code).text; }
export async function runProvider(p, prompt, signal, context = {}) {
  if (signal?.aborted) throw new Failure('任务已取消', 'cancelled');
  const env = { ...process.env, ...p.env };
  // Router configuration is not a credential transport to child AI tools.
  delete env.JIJIN_AI_ROUTER_PROVIDERS;
  delete env.JIJIN_AI_ROUTER_CONFIG;
  let launch;
  try { launch = launchCommand(p.command, env); } catch (e) { throw new Failure(e.message, 'start_failed', ['ENOENT','EACCES'].includes(e.code)); }
  const nativeSessionId=`wechat-${String(context.id || 'task').replace(/[^A-Za-z0-9_-]/g,'-')}`.slice(0,120);
  const replacements={prompt,model:p.model || '',taskId:String(context.id || ''),sessionId:String(context.sessionId || ''),nativeSessionId,source:String(context.source || '')};
  let args = p.args.map(x => Object.entries(replacements).reduce((value,[key,replacement])=>value.replaceAll(`{${key}}`,replacement),x));
  const promptArg = p.args.some(x => x.includes('{prompt}'));
  if (p.model) {
    if (p.modelArg) args = [p.modelArg, p.model, ...args];
    else if (p.preset) args.splice(p.preset === 'codex' ? 1 : 0, 0, '--model', p.model);
  }
  if (p.input === 'arg' && !promptArg) args.push(prompt);
  return new Promise((resolve,reject) => {
    let child, timer, idleTimer, escalation, finalTimer, stopping, settled = false;
    let out = '', err = '', bytes = 0;
    const kill = (force) => {
      if (!child?.pid) return;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill.exe', ['/PID',String(child.pid),'/T',...(force ? ['/F'] : [])], { windowsHide:true, stdio:'ignore' });
        killer.on('error', () => child.kill());
      } else { try { process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM'); } catch {} }
    };
    const finish = (error,value) => {
      if (settled) return; settled = true;
      clearTimeout(timer); clearTimeout(idleTimer); clearTimeout(escalation); clearTimeout(finalTimer); signal?.removeEventListener('abort',cancel);
      // Also clean up descendants that kept running after the CLI returned.
      if (process.platform !== 'win32') kill(true);
      error ? reject(error) : resolve(value);
    };
    const stoppedFailure = (kind) => {
      if (kind === 'idle_timeout') {
        const progress = inspectStructuredProgress(p,out);
        if (progress && !progress.toolUsed) return new Failure('AI 长时间无进展且尚未执行本机工具，已安全切换备用工具。','unavailable',true);
        return new Failure('AI 长时间无进展，执行状态不确定；未自动重试。','timeout');
      }
      return new Failure('任务已停止，执行结果不确定；未自动重试。',kind);
    };
    const stop = (kind) => {
      if (stopping) return; stopping = kind; kill(false);
      escalation = setTimeout(() => kill(true), 1000);
      finalTimer = setTimeout(() => { child.stdout?.destroy(); child.stderr?.destroy(); child.stdin?.destroy(); child.unref(); finish(stoppedFailure(kind)); }, 2500);
    };
    const resetIdleTimer = () => {
      if (!p.idleTimeoutSeconds || stopping || settled) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => stop('idle_timeout'),p.idleTimeoutSeconds*1000);
    };
    const cancel = () => stop('cancelled');
    child = spawn(launch.command,[...launch.prefix,...args], {cwd:p.cwd,env,shell:false,windowsHide:true,detached:process.platform !== 'win32',stdio:['pipe','pipe','pipe']});
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data',chunk => { bytes += Buffer.byteLength(chunk); if (bytes > 8*1024*1024) stop('output_limit'); else { out += chunk; resetIdleTimer(); } });
    child.stderr.on('data',chunk => { err = (err + chunk).slice(-65536); });
    child.stdin.on('error',e => { if (e.code !== 'EPIPE') stop('input_failed'); });
    child.on('error',e => finish(new Failure('AI 进程无法启动，请检查命令与工作目录。','start_failed',['ENOENT','EACCES'].includes(e.code))));
    child.on('close',(code) => {
      if (stopping) return finish(stoppedFailure(stopping));
      try {
        const result=parseResultDetails(p,out,err,code);
        if(!result.nativeTaskId && p.args.some(x=>x.includes('{nativeSessionId}'))) result.nativeTaskId=nativeSessionId;
        finish(null,result);
      } catch(e) { finish(e); }
    });
    timer = setTimeout(() => stop('timeout'),p.timeoutSeconds*1000);
    resetIdleTimer();
    signal?.addEventListener('abort',cancel,{once:true});
    if (signal?.aborted) cancel();
    child.stdin.end(p.input === 'stdin' && !promptArg ? prompt : '');
  });
}
