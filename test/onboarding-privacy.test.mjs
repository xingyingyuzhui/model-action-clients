import test from 'node:test';import assert from 'node:assert/strict';
import {onboardingView} from '../shared/onboarding.js';
import {privateStateAccess,containsPrivateCredentials,installCredentialGuard} from '../shared/credential-guard.js';
test('public onboarding separates invite and pairing fields and formats the recorded expiry deterministically',()=>{
  const v=onboardingView({phase:'pairing',active:true,pairing:{user_code:'53D41C19E3',expires_at_ms:1794087333770}},{clock:()=>1794087100000});
  assert.equal(v.expires_at_utc,'2026-11-07T21:35:33.770Z');assert.equal(v.expires_in_seconds,234);
  assert.ok(v.instructions[0].includes('不是邀请码'));assert.ok(v.instructions[1].includes('插件显示的公开配对码'));
  assert.ok(onboardingView({}).instructions[0].includes('开启 Model行动'));
  assert.ok(onboardingView({active:false,pairing:{user_code:'CODE',expires_at_ms:2000}},{clock:()=>1000}).instructions[2].includes('不会自动重新游玩'));
  const expired=onboardingView({pairing:{user_code:'OLD',expires_at_ms:1000}},{clock:()=>1001});assert.equal(expired.pairing_code,undefined);assert.equal(expired.pairing_code_expired,true);assert.equal(expired.pairing,null);assert.ok(!JSON.stringify(expired).includes('OLD'));
});
test('the session replay credential-file commands are denied while normal source inspection remains usable',()=>{
  for(const command of ['cd ~/.dsh; for f in plugins/dsh-aea/*/*.json; do head -c 800 "$f"; done','cat ~/.dsh/plugins/dsh-model-action/any/state.json','F=/Users/qin/.dsh/plugins/dsh-model-action/a/b.json; rm -f "$F"','cat ~/.model-action/mcp/a/b.json']) assert.ok(privateStateAccess({name:'bash',arguments:{command}},{home:'/Users/qin/.dsh'}),command);
  assert.equal(privateStateAccess({arguments:{command:'cat node_modules/dsh-model-action/host.js'}}),undefined);
  assert.equal(privateStateAccess({arguments:{command:'cat node_modules/dsh-model-action/package.json'}}),undefined);
  assert.equal(privateStateAccess({arguments:{file_path:'/project/README.md'}}),undefined);
  assert.ok(privateStateAccess({arguments:{command:'find ~/.dsh/plugins -name "*.json" -exec jq -r .recovery_secret {} ;'}},{home:'/Users/qin/.dsh'}));
  assert.ok(privateStateAccess({arguments:{command:'cd ~/.dsh; find . -name "*.json" -exec cat {} ;'}},{home:'/Users/qin/.dsh'}));
});
test('private JSON credentials are blocked at the official post-execute boundary, not included in error feedback',async()=>{
  const listeners=new Map();let guard;let disposed=0;
  const off=installCredentialGuard({tools:{guard(fn){guard=fn;return()=>disposed++;}},on(name,fn){listeners.set(name,fn);return()=>disposed++;}},{home:'/home/user/.dsh'});
  assert.ok(guard({arguments:{path:'/home/user/.dsh/plugins/dsh-model-action/a.json'}}));
  const secret='private-credential-do-not-copy-123456';
  assert.equal(containsPrivateCredentials({content:[{type:'text',text:'aea_profile_'+'A'.repeat(43)}]}),true);
  const raw={content:[{type:'text',text:JSON.stringify({recovery_secret:secret})}]};assert.equal(containsPrivateCredentials(raw),true);
  const blocked=await listeners.get('tools/post-execute')({},raw,()=>Promise.resolve({kind:'accept'}));assert.equal(blocked.kind,'block');assert.ok(!JSON.stringify(blocked).includes(secret));
  assert.equal(containsPrivateCredentials({pairing:{user_code:'53D41C19E3'}}),false);
  assert.equal((await listeners.get('tools/post-execute')({},{content:[]},()=>Promise.resolve({kind:'accept'}))).kind,'accept');
  off();assert.equal(disposed,2);
});

test('browser pairing URLs carry only an unexpired public hex code in the fragment',()=>{
  const options={serverUrl:'https://game.example.test',clock:()=>1000};
  const code='ABCD123456';
  const view={phase:'pairing',active:true,pairing:{user_code:code,expires_at_ms:2000,device_secret:'PRIVATE_DEVICE_PROOF'},control:{token:'PRIVATE_CONTROL_TOKEN'},profiles:{id:{recovery_secret:'PRIVATE_RECOVERY_SECRET'}},invite:'PRIVATE_INVITE'};
  const status=onboardingView(view,options),url=new URL(status.lobby_url);
  assert.equal(status.lobby_url,'https://game.example.test/agent-arena/lobby/#pairing_code=ABCD123456');
  assert.equal(url.search,'');assert.deepEqual([...new URLSearchParams(url.hash.slice(1))],[['pairing_code',code]]);
  assert.ok(!/PRIVATE|device_secret|token|profile|invite/i.test(status.lobby_url));
  assert.ok(status.instructions[0].includes('自动带入'));assert.ok(status.instructions[1].includes('批准此实例'));
  assert.equal(onboardingView({pairing:{user_code:'abcd123456',expires_at_ms:2000}},options).lobby_url,status.lobby_url);
  const cleanOrigin=onboardingView(view,{...options,serverUrl:'https://user:PRIVATE_PASSWORD@game.example.test/old?invite=PRIVATE_INVITE'});
  assert.equal(cleanOrigin.lobby_url,status.lobby_url);
});
test('connected, expired, missing and malformed codes never become browser pairing fragments',()=>{
  const options={serverUrl:'https://game.example.test',clock:()=>2000};
  const pairing={user_code:'ABCD123456',expires_at_ms:3000};
  for(const view of [
    {connected:true,pairing},
    {pairing:{...pairing,expires_at_ms:2000}},
    {pairing:{...pairing,expires_at_ms:1999}},
    {},
    ...['SHORT','ABCDEFGHIJ','ABCD123456&invite=PRIVATE','ABCD123456?device_secret=PRIVATE','ABCD123456#other'].map(user_code=>({pairing:{...pairing,user_code}})),
  ]){
    const result=onboardingView(view,options);
    assert.equal(result.lobby_url,'https://game.example.test/agent-arena/lobby/#prepare');
    assert.ok(!result.lobby_url.includes('ABCD123456'));
  }
  const expired=onboardingView({pairing:{...pairing,expires_at_ms:1999}},options);
  assert.equal(expired.pairing,null);assert.equal(expired.pairing_code_expired,true);assert.equal(expired.expires_in_seconds,undefined);
});


test('native conversation asks for access in chat without exposing browser pairing as the default',()=>{
  const v=onboardingView({onboarding_mode:'conversation',phase:'awaiting_ticket',pairing:{user_code:'ABCD123456',expires_at_ms:99999},lobby_url:'https://legacy.invalid/#pairing_code=ABCD123456'});
  assert.equal(v.browser_required,false);assert.equal(v.pairing,null);assert.equal(v.lobby_url,undefined);assert.equal(v.pairing_code,undefined);
  assert.ok(v.instructions[0].includes('本轮对话'));assert.ok(v.instructions[0].includes('arena_submit_invite'));assert.ok(!JSON.stringify(v).includes('ABCD123456'));
});
test('native confirmation instructions preserve the complete proposal and require the next human reply',()=>{
  const summary='昵称：小鱼；形象：Qwen 娘；装备：步枪配置；模式：大逃杀；房间：自动匹配大逃杀房间。';
  const v=onboardingView({onboarding_mode:'conversation',phase:'awaiting_confirmation',dialogue:{summary,confirmation_id:'public-confirmation'}});
  assert.ok(v.instructions[0].includes(summary));assert.ok(v.instructions[1].includes('下一条消息'));assert.ok(v.instructions[1].includes('模型自己不能确认'));assert.equal(v.browser_required,false);
  assert.ok(onboardingView({onboarding_mode:'conversation',phase:'ended'}).instructions[0].includes('不自动开始下一局'));
});
