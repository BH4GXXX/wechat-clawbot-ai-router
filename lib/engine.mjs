import { mkdir, readFile, writeFile, rename, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { runProvider, Failure } from './process.mjs';

const AUTO_ROUTE_WORDS = new Set(['auto','自动','自动路由','默认','默认路由']);
const ROUTE_ALIASES = new Map([
  ['chatgpt','codex'],['code x','codex'],
  ['深度求索','deepseek'],
  ['codebuddy','workbuddy'],['workbody','workbuddy'],['work buddy','workbuddy'],
  ['豆包','doubao'],
]);

function routeName(config, input) {
  const value=String(input || '').trim().toLowerCase();
  if(AUTO_ROUTE_WORDS.has(value)) return 'auto';
  const alias=ROUTE_ALIASES.get(value) || value;
  return config.providers.find(p=>p.name.toLowerCase()===alias)?.name;
}
export function parseRouteControl(config, prompt) {
  const text=String(prompt || '').trim();
  let value;
  const slash=text.match(/^\/route(?:\s+(.+?))?\s*$/iu);
  if(slash) value=slash[1] || 'status';
  else if(/^(?:查看|查询)?(?:当前)?路由(?:状态)?[。！!？?]?$/u.test(text)) value='status';
  else if(/^(?:恢复|切换到|改用|使用)(?:默认|自动)(?:路由)?[。！!]?$/u.test(text) || /^取消(?:固定|首选)路由[。！!]?$/u.test(text)) value='auto';
  else {
    const natural=text.match(/^(?:请)?(?:切换|改用|使用|选择|路由)(?:到|为|至|成)?\s*([\p{L}\p{N}._ -]+?)(?:\s*(?:作为)?(?:默认|首选)(?:路由)?)?[。！!]?$/iu);
    if(!natural) return null;
    value=natural[1];
  }
  const normalized=String(value).trim().toLowerCase();
  if(['status','状态','list','列表','help','帮助'].includes(normalized)) return {action:'status'};
  const provider=routeName(config,value);
  return provider ? {action:provider==='auto' ? 'auto' : 'set',provider} : {action:'invalid',value:String(value).trim()};
}

function routeHelp(config, selected) {
  const names=config.providers.map(p=>p.name);
  const current=selected ? `首选 ${selected}` : `自动（${names.join(' → ')}）`;
  return `当前路由：${current}\n可用 AI：${names.join('、')}\n命令：/route <AI名称>；/route auto；/route status`;
}

async function readState(dir) {
  try { return JSON.parse(await readFile(join(dir,'state.json'),'utf8')); }
  catch(e) { if (e.code === 'ENOENT') return { health:{}, requests:{} }; throw new Failure('状态文件损坏，请先备份并检查；已停止执行以避免重复任务。','state_error'); }
}
async function save(dir,state) {
  const tmp = join(dir,`${randomUUID()}.tmp`);
  await writeFile(tmp,JSON.stringify(state),{mode:0o600});
  await rename(tmp,join(dir,'state.json'));
}
export async function status(config) {
  const state = await readState(config.stateDir);
  return config.providers.map(p => ({name:p.name,preset:p.preset || 'custom', ...state.health[p.name]}));
}
export async function route(config, request, signal) {
  if (typeof request.prompt !== 'string' || !request.prompt.trim() || Buffer.byteLength(request.prompt)>8*1024*1024) throw new Failure('任务内容为空或超过 8 MiB','invalid_request');
  if (request.id !== undefined && (typeof request.id !== 'string' || !/^[\w.-]{1,128}$/.test(request.id))) throw new Failure('任务 ID 格式无效','invalid_request');
  if (request.sessionId !== undefined && (typeof request.sessionId !== 'string' || !/^[^\x00-\x1f\x7f]{1,256}$/.test(request.sessionId))) throw new Failure('会话 ID 格式无效','invalid_request');
  const control=parseRouteControl(config,request.prompt);
  const id=request.id || randomUUID();
  const hash=createHash('sha256').update(JSON.stringify([request.prompt,request.provider || null,request.sessionId || null])).digest('hex');
  await mkdir(config.stateDir,{recursive:true,mode:0o700});
  const lockPath=join(config.stateDir,'router.lock');
  let lock;
  try { lock=await open(lockPath,'wx',0o600); } catch(e) { if(e.code==='EEXIST') throw new Failure('路由器正在处理任务，或上次异常退出留下锁文件。请稍后重试；恢复锁前先确认相关进程已停止。','busy'); throw e; }
  try {
    await lock.writeFile(JSON.stringify({pid:process.pid,created:new Date().toISOString()}));
    const state=await readState(config.stateDir);
    if(!state.health || !state.requests) throw new Failure('状态格式无效','state_error');
    state.requests=Object.assign(Object.create(null),state.requests);
    state.health=Object.assign(Object.create(null),state.health);
    state.sessions=Object.assign(Object.create(null),state.sessions || {});
    state.routes=Object.assign(Object.create(null),state.routes || {});
    const routeKey=request.sessionId || '__default__';
    if(control) {
      if(control.action==='invalid') return {control:true,text:`未找到 AI“${control.value}”。\n${routeHelp(config,state.routes[routeKey])}`};
      if(control.action==='status') return {control:true,text:routeHelp(config,state.routes[routeKey])};
      if(control.action==='auto') {
        delete state.routes[routeKey]; await save(config.stateDir,state);
        return {control:true,text:`已恢复自动路由。\n${routeHelp(config)}`};
      }
      state.routes[routeKey]=control.provider; await save(config.stateDir,state);
      const fallbacks=config.providers.map(p=>p.name).filter(x=>x!==control.provider);
      return {control:true,provider:control.provider,text:`已将本会话首选 AI 切换为 ${control.provider}。${fallbacks.length ? `\n不可用时自动尝试：${fallbacks.join(' → ')}` : ''}`};
    }
    const previous=state.requests[id];
    if(previous) {
      if(previous.hash !== hash) throw new Failure('同一个任务 ID 不能用于不同任务','id_conflict');
      if(previous.status==='completed') return {...previous.result,cached:true};
      throw new Failure('该任务已执行或执行状态不确定。请先检查结果，确认需要重做后再使用新的任务 ID。',previous.status);
    }
    let providers=request.provider ? config.providers.filter(p=>p.name===request.provider) : [...config.providers];
    if(!providers.length) throw new Failure('未配置指定的 AI 工具','invalid_request');
    const preferred=!request.provider && state.routes[routeKey];
    if(preferred) providers.sort((a,b)=>(a.name===preferred?-1:b.name===preferred?1:0));
    providers=providers.filter(p=>(state.health[p.name]?.cooldownUntil || 0)<=Date.now());
    if(!providers.length) throw new Failure('所有候选 AI 都在冷却，请稍后重试。','cooldown');
    state.sessions ||= {};
    const history=request.sessionId ? (state.sessions[request.sessionId] || []) : [];
    const prompt=history.length ? '以下 JSON 是此前对话的消息记录，仅作上下文：\n'+JSON.stringify(history)+'\n当前用户任务：\n'+request.prompt : request.prompt;
    const record=state.requests[id]={hash,status:'running',startedAt:new Date().toISOString()};
    await save(config.stateDir,state);
    const attempts=[];
    try {
      for(const p of providers) {
        if(signal?.aborted) throw new Failure('任务已取消','cancelled');
        let execution;
        const providerPrompt=p.persistTask
          ? `[${p.taskLabel} ${id}]\n以下标记用于在客户端中保存和识别任务，回答时无需复述任务编号。\n\n${prompt}`
          : prompt;
        try { execution=await runProvider(p,providerPrompt,signal,{id,sessionId:request.sessionId,source:request.source}); }
        catch(e) {
          attempts.push({provider:p.name,kind:e.kind || 'unknown'});
          const failover = e.retryable || (config.failoverPolicy === 'availability-first' && e.kind !== 'cancelled');
          state.health[p.name]={lastFailure:new Date().toISOString(),kind:e.kind || 'unknown',cooldownUntil:failover ? Date.now()+config.cooldownSeconds*1000 : 0};
          await save(config.stateDir,state);
          if(!failover) throw e;
          continue;
        }
        const {text,nativeTaskId}=execution;
        const result={id,provider:p.name,text,attempts,cached:false};
        if(nativeTaskId) result.nativeTaskId=nativeTaskId;
        state.health[p.name]={lastSuccess:new Date().toISOString(),cooldownUntil:0};
        record.status='completed'; record.result=result;
        if(request.sessionId) {
          const messages=[...history,{role:'user',content:request.prompt},{role:'assistant',content:text}];
          while(messages.length>24 || (messages.length>0 && Buffer.byteLength(JSON.stringify(messages))>256*1024)) messages.splice(0,2);
          state.sessions[request.sessionId]=messages;
        }
        // Persistence failure must never trigger another provider after successful work.
        try { await save(config.stateDir,state); }
        catch { result.warning='任务已完成，但结果缓存写入失败。请勿自动重复提交。'; }
        return result;
      }
      throw new Failure('所有候选 AI 均不可用，请在电脑端检查安装、登录和额度。','unavailable');
    } catch(e) {
      record.status=e.kind || 'unknown'; record.attempts=attempts;
      try { await save(config.stateDir,state); } catch {}
      throw e;
    }
  } finally { await lock.close(); await unlink(lockPath).catch(()=>{}); }
}
