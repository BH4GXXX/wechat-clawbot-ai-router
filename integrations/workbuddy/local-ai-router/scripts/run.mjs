import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

try {
  const args=process.argv.slice(2);
  let settingsFile=new URL('../settings.json',import.meta.url), requestFile, doctor=false;
  while(args.length) {
    const key=args.shift();
    if(key==='--doctor') doctor=true;
    else if(['--settings','--request'].includes(key) && args.length) {
      const value=args.shift();if(key==='--settings') settingsFile=resolve(value);else requestFile=resolve(value);
    } else throw new Error('用法：run.mjs --doctor 或 run.mjs --request 请求文件.json');
  }
  if(doctor === Boolean(requestFile)) throw new Error('请选择 --doctor 或 --request 其中一项');
  const settings=JSON.parse(await readFile(settingsFile,'utf8'));
  if(typeof settings.routerRoot!=='string' || typeof settings.nodeBinary!=='string') throw new Error('请配置 settings.json 中的 routerRoot 和 nodeBinary');
  const root=resolve(settings.routerRoot);
  const config=resolve(root,settings.configFile || 'config.json');
  let input;
  if(requestFile) {
    const request=JSON.parse(await readFile(requestFile,'utf8'));
    if(typeof request.id!=='string' || !request.id) throw new Error('请求必须包含稳定的任务 id');
    if(typeof request.prompt!=='string' || !request.prompt.trim()) throw new Error('请求缺少 prompt');
    input=JSON.stringify(request);
  }
  const child=spawn(settings.nodeBinary,[resolve(root,'cli.mjs'),doctor?'doctor':'run','--config',config,...(doctor?[]:['--json'])],{cwd:root,shell:false,windowsHide:true,stdio:['pipe','inherit','inherit']});
  for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>child.kill(signal));
  child.stdin.on('error',e=>{if(e.code!=='EPIPE') console.error('路由器输入失败');});
  child.on('error',()=>{console.error('无法启动路由器，请检查 Node 和项目路径');process.exitCode=1;});
  child.on('close',code=>{process.exitCode=code ?? 1;});
  child.stdin.end(input);
} catch(e) {console.error(JSON.stringify({error:'bridge_error',message:e.message}));process.exitCode=1;}
