import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeConfig } from '../lib/config.mjs';
import { route } from '../lib/engine.mjs';
import { parseResult } from '../lib/process.mjs';
const node=(name,script,extra={})=>({name,command:process.execPath,args:['-e',script],...extra});
async function fixture(t,providers) { const dir=await mkdtemp(join(tmpdir(),'ai router '));t.after(()=>rm(dir,{recursive:true,force:true}));return normalizeConfig({stateDir:dir,failoverPolicy:'safe',providers}); }
const print=text=>`process.stdout.write(${JSON.stringify(text)})`;
const marker=(file,text='done')=>`require('node:fs').writeFileSync(${JSON.stringify(file)},'1');process.stdout.write(${JSON.stringify(text)})`;
const unavailable=JSON.stringify({type:'turn.failed',error:{message:'quota exceeded'}})+'\n';

test('正常回复出现额度和 quota 不触发切换',async t=>{
 const c=await fixture(t,[node('first',print('解释 quota 和额度限制')),node('second',print('wrong'))]);
 const r=await route(c,{prompt:'解释'});assert.equal(r.provider,'first');assert.match(r.text,/quota/);
});
test('未安装的 CLI 自动切换',async t=>{
 const c=await fixture(t,[{name:'missing',command:'/not-installed-ai'},node('second',print('完成'))]);
 const r=await route(c,{prompt:'任务'});assert.equal(r.provider,'second');assert.equal(r.attempts[0].kind,'start_failed');
});
test('结构化额度错误在未调用工具时允许切换',async t=>{
 const c=await fixture(t,[node('limited',print(unavailable)+';process.exitCode=1',{output:'codex-jsonl'}),node('backup',print('done'))]);
 assert.equal((await route(c,{prompt:'任务'})).provider,'backup');
});
test('执行过工具后即使出现额度错误也不重放',async t=>{
 const text=JSON.stringify({type:'item.started',item:{type:'command_execution'}})+'\n'+unavailable;
 const c=await fixture(t,[node('partial',print(text)+';process.exitCode=1',{output:'codex-jsonl'}),node('backup',print('wrong'))]);
 await assert.rejects(route(c,{prompt:'改文件'}),e=>e.kind==='unknown');
});
test('非结构化错误默认不自动重放',async t=>{
 const c=await fixture(t,[node('custom',"console.error('quota exceeded');process.exitCode=1"),node('backup',print('wrong'))]);
 await assert.rejects(route(c,{prompt:'任务'}),e=>e.kind==='unknown');
});
test('超时停止，备用工具不执行',async t=>{
 const c=await fixture(t,[node('slow','setInterval(()=>{},1000)',{timeoutSeconds:0.05}),node('backup',print('wrong'))]);
 await assert.rejects(route(c,{prompt:'任务'}),e=>e.kind==='timeout');
});
test('相同任务 ID 返回缓存，不再次调用 CLI',async t=>{
 const c=await fixture(t,[node('first','console.log(Math.random())')]);
 const first=await route(c,{id:'msg-1',prompt:'任务'});const second=await route(c,{id:'msg-1',prompt:'任务'});
 assert.equal(first.text,second.text);assert.equal(second.cached,true);
 await assert.rejects(route(c,{id:'msg-1',prompt:'另一个任务'}),e=>e.kind==='id_conflict');
});
test('任务失败后相同 ID 不自动重跑',async t=>{
 const c=await fixture(t,[node('bad','process.exitCode=1')]);
 await assert.rejects(route(c,{id:'bad',prompt:'任务'}));
 await assert.rejects(route(c,{id:'bad',prompt:'任务'}),/已执行或执行状态不确定/);
});
test('冷却期间不会绕过冷却重新尝试',async t=>{
 const c=await fixture(t,[{name:'missing',command:'/not-installed-ai'}]);
 await assert.rejects(route(c,{prompt:'1'}),e=>e.kind==='unavailable');
 await assert.rejects(route(c,{prompt:'2'}),e=>e.kind==='cooldown');
});
test('同一路由状态目录拒绝并发执行',async t=>{
 const c=await fixture(t,[node('slow',"setTimeout(()=>console.log('ok'),250)")]);
 const one=route(c,{prompt:'1'});
 while(true) { try { await readFile(join(c.stateDir,'router.lock'));break; } catch { await new Promise(r=>setTimeout(r,5)); } }
 await assert.rejects(route(c,{prompt:'2'}),e=>e.kind==='busy');await one;
});
test('取消信号中断任务',async t=>{
 const c=await fixture(t,[node('slow','setInterval(()=>{},1000)')]);const abort=new AbortController();
 setTimeout(()=>abort.abort(),60);
 await assert.rejects(route(c,{prompt:'1'},abort.signal),e=>e.kind==='cancelled');
});
test('Claude 结构化结果与权限拒绝',()=>{
 const p=normalizeConfig({providers:[{name:'claude',preset:'claude'}]}).providers[0];
 assert.equal(parseResult(p,JSON.stringify({type:'result',subtype:'success',result:'quota 是额度'}),'',0),'quota 是额度');
 assert.throws(()=>parseResult(p,JSON.stringify({type:'result',subtype:'success',result:'done',permission_denials:[{}]}),'',0),e=>e.kind==='permission_required');
});
test('配置默认预设、错误正则、重复名称验证',()=>{
 const p=normalizeConfig({providers:[{name:'codex',preset:'codex'}]}).providers[0];assert.equal(p.output,'codex-jsonl');assert.equal(p.args[0],'exec');
 assert.equal(normalizeConfig({providers:[{name:'a',command:'x'}]}).failoverPolicy,'availability-first');
 assert.throws(()=>normalizeConfig({providers:[{name:'a',command:'x',retryPatterns:['[']}]}));
 assert.throws(()=>normalizeConfig({providers:[{name:'a',command:'x'},{name:'a',command:'y'}]}));
 assert.throws(()=>normalizeConfig({providers:[{name:'a',command:'x',timeoutSeconds:10,idleTimeoutSeconds:11}]}),/空闲超时/);
 assert.throws(()=>normalizeConfig({failoverPolicy:'wrong',providers:[{name:'a',command:'x'}]}),/failoverPolicy/);
});
test('持久化任务添加可见标签、展开原生会话 ID 并保存映射',async t=>{
 const script=`const i=process.argv.indexOf('--session-id');let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>process.stdout.write(JSON.stringify({text:s,nativeTaskId:process.argv[i+1]})))`;
 const c=await fixture(t,[node('visible',script,{args:['-e',script,'--','--session-id','{nativeSessionId}'],output:'json',persistTask:true,taskLabel:'微信 ClawBot 任务'})]);
 const r=await route(c,{id:'message.123',prompt:'整理今天的事项',source:'微信 ClawBot'});
 assert.match(r.text,/\[微信 ClawBot 任务 message\.123\]/);
 assert.match(r.text,/整理今天的事项/);
 assert.equal(r.nativeTaskId,'wechat-message-123');
});
test('输入通过 stdin 传递，不被 shell 展开',async t=>{
 const c=await fixture(t,[node('echo',"process.stdin.pipe(process.stdout)")]);const prompt='中文 `touch nope` $(echo fail) "&|%';
 assert.equal((await route(c,{prompt})).text,prompt);
});

test('独立入口按会话保存上下文并隔离其他会话',async t=>{
 const c=await fixture(t,[node('echo','process.stdin.pipe(process.stdout)')]);
 await route(c,{id:'one',sessionId:'alice',prompt:'我的项目叫星河'});
 const next=await route(c,{id:'two',sessionId:'alice',prompt:'项目叫什么'});
 assert.match(next.text,/星河/);
 const other=await route(c,{sessionId:'bob',prompt:'项目叫什么'});assert.equal(other.text,'项目叫什么');
 await assert.rejects(route(c,{id:'one',sessionId:'bob',prompt:'我的项目叫星河'}),e=>e.kind==='id_conflict');
});

test('/route 按会话保存首选 AI，并保留不可用时的自动接管',async t=>{
 const c=await fixture(t,[node('codex',print('CODEX')),node('workbuddy',print('WORKBUDDY'))]);
 const switched=await route(c,{sessionId:'wechat:alice',prompt:'/route workbuddy'});
 assert.equal(switched.control,true);assert.equal(switched.provider,'workbuddy');
 assert.equal((await route(c,{sessionId:'wechat:alice',prompt:'任务'})).provider,'workbuddy');
 assert.equal((await route(c,{sessionId:'wechat:bob',prompt:'任务'})).provider,'codex');

 const dir=await mkdtemp(join(tmpdir(),'route fallback '));t.after(()=>rm(dir,{recursive:true,force:true}));
 const fallback=normalizeConfig({stateDir:dir,failoverPolicy:'availability-first',providers:[node('codex',print('CODEX')),node('workbuddy','process.exitCode=1')]});
 await route(fallback,{sessionId:'wechat:alice',prompt:'/route workbuddy'});
 const result=await route(fallback,{sessionId:'wechat:alice',prompt:'任务'});
 assert.equal(result.provider,'codex');
 assert.deepEqual(result.attempts,[{provider:'workbuddy',kind:'unknown'}]);
});

test('自然语言可切换路由，auto 恢复优先级顺序且未知名称不调用 AI',async t=>{
 const markerFile=join(tmpdir(),`route-control-${Date.now()}-${Math.random()}`);t.after(()=>rm(markerFile,{force:true}));
 const c=await fixture(t,[node('codex',marker(markerFile,'CODEX')),node('doubao',print('DOUBAO'))]);
 assert.equal((await route(c,{sessionId:'s',prompt:'请切换到豆包'})).provider,'doubao');
 assert.equal((await route(c,{sessionId:'s',prompt:'任务一'})).provider,'doubao');
 await assert.rejects(readFile(markerFile),e=>e.code==='ENOENT');
 const invalid=await route(c,{sessionId:'s',prompt:'/route 不存在的AI'});
 assert.equal(invalid.control,true);assert.match(invalid.text,/未找到/);
 await route(c,{sessionId:'s',prompt:'恢复自动路由'});
 assert.equal((await route(c,{sessionId:'s',prompt:'任务二'})).provider,'codex');
});

test('router.mjs 接收 OpenClaw sessionArgs 并让 /route 对后续消息生效',async t=>{
 const {spawn}=await import('node:child_process');const {fileURLToPath}=await import('node:url');
 const dir=await mkdtemp(join(tmpdir(),'router session '));t.after(()=>rm(dir,{recursive:true,force:true}));
 const raw=normalizeConfig({stateDir:dir,providers:[node('codex',print('CODEX')),node('deepseek',print('DEEPSEEK'))]});
 const file=fileURLToPath(new URL('../router.mjs',import.meta.url));
 const invoke=(prompt)=>new Promise((resolve,reject)=>{
   const child=spawn(process.execPath,[file,'--session-id','openclaw:wechat:alice'],{env:{...process.env,JIJIN_AI_ROUTER_CONFIG:JSON.stringify(raw)}});
   let out='',err='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);child.stdin.end(prompt);
   child.on('close',code=>code===0?resolve(out):reject(new Error(err)));
 });
 assert.match(await invoke('/route deepseek'),/已将本会话首选 AI/);
 assert.equal(await invoke('任务'),'DEEPSEEK');
});

test('真实命令入口接收 JSON 并返回可供 ClawBot 回传的结果',async t=>{
 const {spawn}=await import('node:child_process');
 const {fileURLToPath}=await import('node:url');
 const c=await fixture(t,[node('echo','process.stdin.pipe(process.stdout)')]);
 const file=join(c.stateDir,'config.json');await writeFile(file,JSON.stringify(c));
 const child=spawn(process.execPath,[fileURLToPath(new URL('../cli.mjs',import.meta.url)),'run','--config',file,'--json']);
 let output='',error='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>error+=x);
 child.stdin.end(JSON.stringify({id:'wechat-123',sessionId:'chat-1',prompt:'来自微信的任务'}));
 const code=await new Promise(r=>child.on('close',r));assert.equal(code,0,error);
 const result=JSON.parse(output);assert.equal(result.id,'wechat-123');assert.equal(result.text,'来自微信的任务');
});

test('WorkBuddy 技能入口读取请求文件并调用独立路由器',async t=>{
 const {spawn}=await import('node:child_process');const {fileURLToPath}=await import('node:url');
 const c=await fixture(t,[node('echo','process.stdin.pipe(process.stdout)')]);
 const root=fileURLToPath(new URL('..',import.meta.url));
 const config=join(c.stateDir,'config.json'),settings=join(c.stateDir,'settings.json'),request=join(c.stateDir,'request.json');
 await writeFile(config,JSON.stringify(c));await writeFile(settings,JSON.stringify({nodeBinary:process.execPath,routerRoot:root,configFile:config}));
 await writeFile(request,JSON.stringify({id:'wb-message-1',prompt:'微信任务 "quoted" $(literal)'}));
 const child=spawn(process.execPath,[join(root,'integrations/workbuddy/local-ai-router/scripts/run.mjs'),'--settings',settings,'--request',request]);
 let out='',err='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);
 const code=await new Promise(r=>child.on('close',r));assert.equal(code,0,err);assert.equal(JSON.parse(out).text,'微信任务 "quoted" $(literal)');
});

test('初始化固化绝对路径，切换到最小 PATH 后诊断仍可找到同一 CLI',async t=>{
 const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');
 const {symlink}=await import('node:fs/promises');const {fileURLToPath}=await import('node:url');
 const dir=await mkdtemp(join(tmpdir(),'router path '));t.after(()=>rm(dir,{recursive:true,force:true}));
 const binary=join(dir,process.platform==='win32'?'codex.exe':'codex');
 await symlink(process.execPath,binary);
 const cli=fileURLToPath(new URL('../cli.mjs',import.meta.url));const config=join(dir,'config.json');
 const exec=promisify(execFile);
 await exec(process.execPath,[cli,'init','--config',config],{env:{...process.env,PATH:dir}});
 const saved=JSON.parse(await readFile(config,'utf8'));
 assert.equal(saved.providers[0].command,binary);
 const {stdout}=await exec(process.execPath,[cli,'doctor','--config',config],{env:{...process.env,PATH:''}});
 const provider=JSON.parse(stdout).providers[0];assert.equal(provider.command,binary);assert.equal(provider.pathIndependent,true);
});

test('遗留锁不导致删除状态或重放任务',async t=>{
 const c=await fixture(t,[node('echo',print('ok'))]);
 await route(c,{id:'done-before-lock',prompt:'任务'});
 const state=await readFile(join(c.stateDir,'state.json'),'utf8');
 await writeFile(join(c.stateDir,'router.lock'),JSON.stringify({pid:99999999}));
 await assert.rejects(route(c,{prompt:'新任务'}),e=>e.kind==='busy');
 assert.equal(await readFile(join(c.stateDir,'state.json'),'utf8'),state);
});

test('损坏状态文件时拒绝执行并保留诊断内容',async t=>{
 const c=await fixture(t,[node('echo',print('should not run'))]);
 await writeFile(join(c.stateDir,'state.json'),'broken-json');
 await assert.rejects(route(c,{prompt:'任务'}),e=>e.kind==='state_error');
 assert.equal(await readFile(join(c.stateDir,'state.json'),'utf8'),'broken-json');
});
