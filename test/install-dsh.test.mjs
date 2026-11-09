import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {placeDshBundle} from '../bin/place-dsh-bundle.mjs';
const installer=fileURLToPath(new URL('../bin/install-dsh.mjs',import.meta.url));
test('installer refuses accidental legacy duplication and dry-run does not modify profile settings',t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'model-action-install-test-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const dir=path.join(home,'profiles','desktop');fs.mkdirSync(dir,{recursive:true});
  const previous='\uFEFF'+JSON.stringify({dependencies:{['dsh-'+'aea']:'0.2.0',unrelated:'1.0.0'},dsh:{profile:{bundles:['unrelated','dsh-'+'aea']}},model:{provider:'unchanged'}});
  fs.writeFileSync(path.join(dir,'package.json'),previous);
  const call=args=>spawnSync(process.execPath,[installer,'--profile','desktop',...args],{env:{...process.env,DSH_HOME:home},encoding:'utf8'});
  const denied=call(['--dry-run']);assert.notEqual(denied.status,0);assert.match(denied.stderr,/legacy_plugin_present/);
  const plan=call(['--dry-run','--replace-legacy']);assert.equal(plan.status,0,plan.stderr);
  assert.equal(JSON.parse(plan.stdout).changes_applied,false);
  assert.equal(fs.readFileSync(path.join(dir,'package.json'),'utf8'),previous);
  assert.ok(!fs.existsSync(path.join(dir,'.dsh-local-plugins')));
});

test('real-directory placement retains isolated peer resolution without profile dependencies',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'model-action-bundle-copy-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const runtime=path.join(root,'runtime'),modules=path.join(runtime,'node_modules'),staged=path.join(modules,'dsh-model-action'),current=path.join(root,'profile','node_modules','dsh-model-action');
  fs.mkdirSync(staged,{recursive:true});
  fs.writeFileSync(path.join(staged,'package.json'),JSON.stringify({name:'dsh-model-action',type:'module'}));
  fs.writeFileSync(path.join(staged,'host.js'),"export {value} from '@deepseek-ai/dsh-tools';");
  const peer=path.join(modules,'@deepseek-ai','dsh-tools');fs.mkdirSync(peer,{recursive:true});
  fs.writeFileSync(path.join(peer,'package.json'),JSON.stringify({name:'@deepseek-ai/dsh-tools',type:'module',exports:'./index.js'}));
  fs.writeFileSync(path.join(peer,'index.js'),'export const value = 42;');
  placeDshBundle({runtime,staged,current,copy:true});
  assert.equal(fs.lstatSync(current).isSymbolicLink(),false);
  assert.equal(fs.existsSync(path.join(current,'node_modules','dsh-model-action')),false);
  fs.rmSync(runtime,{recursive:true,force:true});
  assert.equal((await import(pathToFileURL(path.join(current,'host.js')))).value,42);
});
