#!/usr/bin/env node
// Exact Desktop version pins + hashed local tarball override, following the
// established local DSH bundle installation contract. Never changes the host app.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {parseDocument} from 'yaml';
import {placeDshBundle} from './place-dsh-bundle.mjs';

const lexists=file=>{try{fs.lstatSync(file);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}};
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2),profiles=[];
if(args.includes('--help')) { console.log('model-action-install-dsh --profile <existing-profile> [--dry-run] [--replace-legacy]\nInstalls Model行动 into an existing DSH profile, preserving model settings.');process.exit(0); }
const dryRun=args.includes('--dry-run'),replaceLegacy=args.includes('--replace-legacy');
const flags=new Set(['--dry-run','--replace-legacy']);

for(let i=0;i<args.length;i++){if(flags.has(args[i]))continue;if(args[i]!=='--profile'||!args[i+1]||!/^[a-zA-Z0-9_-]{1,60}$/.test(args[i+1]))throw new Error('Use --profile <existing-profile>');profiles.push(args[++i]);}
if(!profiles.length)throw new Error('An explicit --profile is required');
const home=process.env.DSH_HOME??path.join(os.homedir(),'.dsh');
const pkgDir=root,pkg=JSON.parse(fs.readFileSync(path.join(pkgDir,'package.json'),'utf8'));
// Windows .cmd shims need a shell. Use npx's Node entry instead so profile
// paths stay literal arguments, including spaces and shell metacharacters.
const npmCli=process.platform==='win32'?process.env.npm_execpath:null;
if(process.platform==='win32'&&(!npmCli||!path.isAbsolute(npmCli)||!fs.existsSync(npmCli)||path.basename(npmCli)!=='npm-cli.js'))throw new Error('windows_install_requires_npx: use the release npx installation command in README');
const npmCommand=npmCli?process.execPath:'npm';
const npmArguments=args=>npmCli?[npmCli,...args]:args;
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'model-action-pack-'));
try{
  const packed=spawnSync(npmCommand,npmArguments(['pack','--json','--ignore-scripts','--pack-destination',temp]),{cwd:pkgDir,encoding:'utf8'});
  if(packed.status!==0)throw new Error('native_package_pack_failed');
  const info=JSON.parse(packed.stdout)[0],source=path.join(temp,info.filename),hash=createHash('sha256').update(fs.readFileSync(source)).digest('hex').slice(0,16);
  for(const profileName of [...new Set(profiles)]){
    const profile=path.join(home,'profiles',profileName),manifest=path.join(profile,'package.json');
    if(!fs.existsSync(manifest))throw new Error('profile_missing:'+profileName);
    const input=JSON.parse(fs.readFileSync(manifest,'utf8').replace(/^\uFEFF/,''));
    const hasLegacy=Object.hasOwn(input.dependencies??{},'dsh-'+'aea') || input.dsh?.profile?.bundles?.includes('dsh-'+'aea');
    if(hasLegacy&&!replaceLegacy)throw new Error('legacy_plugin_present: rerun with --replace-legacy to back up and replace the old plugin; private identity files are retained');
    if(!Array.isArray(input.dsh?.profile?.bundles))throw new Error('invalid_profile_bundles');
    if(dryRun){console.log(JSON.stringify({profile:profileName,package:pkg.name,version:pkg.version,replaceLegacy:hasLegacy,changes_applied:false}));continue;}
    const local=path.join(profile,'.dsh-local-plugins');fs.mkdirSync(local,{recursive:true,mode:0o700});
    const file=`dsh-model-action-${pkg.version}-${hash}.tgz`;fs.copyFileSync(source,path.join(local,file));
    const backup=path.join(local,'backups','model-action-'+Date.now());fs.mkdirSync(backup,{recursive:true,mode:0o700});
    const files=['package.json','pnpm-workspace.yaml','pnpm-lock.yaml','cordis.patch.yml'];
    const previous=new Map(files.map(f=>[f,fs.existsSync(path.join(profile,f))?fs.readFileSync(path.join(profile,f)):null]));
    for(const [f,value]of previous)if(value)fs.writeFileSync(path.join(backup,f),value,{mode:0o600});
    const current=path.join(profile,'node_modules/dsh-model-action'),oldEntry=path.join(backup,'installed-entry');let swapped=false;
    try{
      // Install the bundle and its exact peers in a private, content-addressed
      // runtime. Rebuilding a live Desktop profile's unrelated modules is unnecessary.
      const runtime=path.join(local,'runtime-'+hash);fs.mkdirSync(runtime,{recursive:true,mode:0o700});
      fs.writeFileSync(path.join(runtime,'package.json'),JSON.stringify({name:'model-action-local-runtime',private:true,dependencies:{'dsh-model-action':'file:'+path.join(local,file)}}));
      const installed=spawnSync(npmCommand,npmArguments(['install','--ignore-scripts','--no-audit','--no-fund']),{cwd:runtime,encoding:'utf8',env:{...process.env,CI:''}});
      fs.writeFileSync(path.join(backup,'install.private.log'),(installed.stdout??'')+(installed.stderr??''),{mode:0o600});
      if(installed.status!==0)throw new Error('profile_install_failed:'+profileName);
      const staged=path.join(runtime,'node_modules/dsh-model-action');
      const actual=JSON.parse(fs.readFileSync(path.join(staged,'package.json'),'utf8'));
      if(actual.version!==pkg.version)throw new Error('profile_install_verification_failed');
      const data=JSON.parse(previous.get('package.json').toString().replace(/^\uFEFF/,''));data.dependencies??={};if(hasLegacy){delete data.dependencies['dsh-'+'aea'];data.dsh.profile.bundles=data.dsh.profile.bundles.filter(x=>x!=='dsh-'+'aea');}data.dependencies['dsh-model-action']=pkg.version;
      if(!Array.isArray(data.dsh?.profile?.bundles))throw new Error('invalid_profile_bundles');
      if(!data.dsh.profile.bundles.includes('dsh-model-action'))data.dsh.profile.bundles.push('dsh-model-action');
      const yaml=parseDocument(previous.get('pnpm-workspace.yaml')?.toString()??'');
      if(yaml.errors.length)throw new Error('invalid_profile_workspace');
      let overlay;
      if(hasLegacy && previous.get('cordis.patch.yml')){
        overlay=parseDocument(previous.get('cordis.patch.yml').toString());
        if(overlay.errors.length)throw new Error('invalid_profile_overlay');
        const items=overlay.contents?.items;
        if(!Array.isArray(items))throw new Error('invalid_profile_overlay');
        const legacy=items.filter(item=>item?.get?.('id')==='aea-native');
        if(legacy.length&&items.some(item=>item?.get?.('id')==='model-action-native'))throw new Error('conflicting_native_overlays');
        for(const item of legacy)item.set('id','model-action-native');
      }

      if(hasLegacy)yaml.deleteIn(['overrides','dsh-'+'aea']);
      yaml.setIn(['overrides','dsh-model-action'],`file:./.dsh-local-plugins/${file}`);
      fs.mkdirSync(path.dirname(current),{recursive:true});
      if(lexists(current))fs.renameSync(current,oldEntry);
      swapped=true;
      placeDshBundle({runtime,staged,current});
      fs.writeFileSync(manifest,JSON.stringify(data,null,2)+'\n');fs.writeFileSync(path.join(profile,'pnpm-workspace.yaml'),yaml.toString());
      if(overlay)fs.writeFileSync(path.join(profile,'cordis.patch.yml'),overlay.toString());
      const resolved=JSON.parse(fs.readFileSync(path.join(current,'package.json'),'utf8'));
      if(resolved.version!==pkg.version||fs.realpathSync(current)===pkgDir)throw new Error('profile_install_verification_failed');
      console.log(JSON.stringify({profile:profileName,version:resolved.version,exact_pin:data.dependencies['dsh-model-action'],backup,isolated_bundle_runtime:true,host_app_unchanged:true}));
    }catch(error){
      try{
        if(swapped){fs.rmSync(current,{recursive:true,force:true});if(lexists(oldEntry))fs.renameSync(oldEntry,current);}
        for(const [f,value]of previous){const target=path.join(profile,f);if(value)fs.writeFileSync(target,value);else fs.rmSync(target,{force:true});}
      }catch{throw new Error('profile_recovery_unverified:'+profileName);}
      throw error;
    }
  }
}finally{fs.rmSync(temp,{recursive:true,force:true});}
