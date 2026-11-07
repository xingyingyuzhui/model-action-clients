// Defense in depth on the official tool pipeline, not an operating-system sandbox.
// The game plugin does not need a model to inspect or edit its private credential files.
import path from 'node:path';
export const PRIVATE_STATE_DENIAL='Model行动私有身份文件禁止通过通用工具读取或修改。请使用 arena_status 或 arena_repair_pairing 排障；不要删除身份文件。';
export const PRIVATE_OUTPUT_DENIAL='工具输出包含私有游戏凭证，已阻止进入会话。请使用 arena_status 或 arena_repair_pairing，不要读取身份文件。';
function encoded(value){try{return typeof value==='string'?value:JSON.stringify(value)??'';}catch{return '';}}
function normalized(value){return encoded(value).replace(/\\/g,'/').replace(/%([0-9a-f]{2})/gi,(_,n)=>String.fromCharCode(parseInt(n,16))).toLowerCase();}
export function privateStateAccess(exec,{home}={}){
  const text=normalized(exec?.arguments??exec?.args);
  const privatePath=/(?:^|[\s/'";=])(?:dsh-model-action|dsh-aea)(?:[/'"\s;*]|$)/.test(text)&&
    /(?:plugins\/|plugins['"\s,)]|\.dsh\/|dsh_home)/.test(text);
  const explicit=home&&[path.join(home,'plugins','dsh-model-action'),path.join(home,'plugins','dsh-aea')].some(p=>text.includes(p.toLowerCase().replace(/\\/g,'/')));
  const mcp=/\.model-action\/mcp(?:[/\s'"*]|$)/.test(text);
  const pluginRoot=home&&[path.join(home,'plugins'),'~/.dsh/plugins','$dsh_home/plugins'].some(p=>text.includes(p.toLowerCase().replace(/\\/g,'/')));
  const recursiveHome=/\.dsh(?:[/'"\s;]|$)/.test(text)&&/(?:find|grep\s+-[a-z]*r|grep\s+--recursive|rg\s|rglob|os\.walk|glob\.glob|readfile|open\s*\(|cat\s|head\s|jq\s)/.test(text);
  return privatePath||explicit||mcp||pluginRoot||recursiveHome?PRIVATE_STATE_DENIAL:undefined;
}
export function containsPrivateCredentials(result){
  const text=encoded(result);
  // Inspect the visible result, including JSON serialized inside text blocks.
  const decoded=text.replace(/\\"/g,'"');
  if(/\baea_profile_[A-Za-z0-9_-]{32,}\b/.test(decoded)||/\baea_[a-f0-9]{48}\b/.test(decoded))return true;
  return /["'](?:device_secret|recovery_secret|control_token|game_token)["']\s*:\s*["'][A-Za-z0-9_-]{16,}["']/.test(decoded)||
    /["']token["']\s*:\s*["'][A-Za-z0-9_-]{16,}["']/.test(decoded);
}
export function installCredentialGuard(ctx,{home}={}){
  const disposers=[];
  // Tool guards are checked after approval; a permissive approval policy cannot bypass them.
  if(typeof ctx.tools?.guard==='function')disposers.push(ctx.tools.guard(exec=>privateStateAccess(exec,{home})));
  disposers.push(ctx.on('tools/post-execute',async(_exec,result,next)=>{
    if(containsPrivateCredentials(result))return {kind:'block',feedback:[{type:'text',text:PRIVATE_OUTPUT_DENIAL}]};
    const decision=await next();
    if(containsPrivateCredentials(decision))return {kind:'block',feedback:[{type:'text',text:PRIVATE_OUTPUT_DENIAL}]};
    return decision;
  }));
  return ()=>{for(const off of disposers)if(typeof off==='function')off();};
}
