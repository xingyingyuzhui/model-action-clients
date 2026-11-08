import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {AtomicStore} from '../shared/store.js';
const ORIGIN='https://arena.test',ID='agent_11111111-1111-4111-8111-111111111111',OTHER='agent_22222222-2222-4222-8222-222222222222';
const TOKEN='model_beta_'+'a'.repeat(43),GRANT={id:'beta_11111111-1111-4111-8111-111111111111',expires_at_ms:Date.now()+86400000,state:'active',max_concurrent_agents:1};
async function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'model-migration-')),file=path.join(dir,'session.json'),store=new AtomicStore(file),sidecar=file+'.native-access.local.json';t.after(async()=>{await store.close();fs.rmSync(dir,{recursive:true,force:true});});
 const original={schema_version:1,origin:ORIGIN,profiles:{[ID]:{public_agent_id:ID,acked:true,recovery_secret:'private-recovery'}},pending_claim:{key:'keep-pending'}};await store.write(original);
 const write=(changes={})=>fs.writeFileSync(sidecar,JSON.stringify({schema_version:1,origin:ORIGIN,public_agent_id:ID,token:TOKEN,grant:GRANT,...changes}),{mode:0o600});return {dir,file,store,sidecar,original,write};}
test('native sidecar is absent by default; valid read is private and never edits main store until caller commits',async t=>{
 const e=await fixture(t);assert.equal(await e.store.readNativeMigration(ORIGIN,[ID]),null);e.write();const original=fs.readFileSync(e.file,'utf8');
 const access=await e.store.readNativeMigration(ORIGIN,[ID]);assert.deepEqual(access,{token:TOKEN,grant:GRANT});assert.equal(fs.readFileSync(e.file,'utf8'),original);assert.ok(fs.existsSync(e.sidecar));
 await assert.rejects(e.store.consumeNativeMigration(),{code:'native_migration_not_committed'});assert.ok(fs.existsSync(e.sidecar));
 await e.store.write({...e.original,native_access:access});assert.equal(await e.store.consumeNativeMigration(),true);assert.equal(fs.existsSync(e.sidecar),false);assert.equal(await e.store.consumeNativeMigration(),false);assert.deepEqual((await e.store.read()).pending_claim,e.original.pending_claim);
});
test('origin and exact acknowledged existing identity binding are enforced even if caller supplies forged profile IDs',async t=>{
 const e=await fixture(t);e.write({origin:'https://other.test'});await assert.rejects(e.store.readNativeMigration(ORIGIN,[ID]),{code:'native_migration_corrupt'});
 e.write({public_agent_id:OTHER});await assert.rejects(e.store.readNativeMigration(ORIGIN,[OTHER]),{code:'native_migration_profile_mismatch'});
 e.write();await assert.rejects(e.store.readNativeMigration(ORIGIN,[]),{code:'native_migration_profile_mismatch'});
 await e.store.write({...e.original,profiles:{[ID]:{public_agent_id:ID,acked:false}}});await assert.rejects(e.store.readNativeMigration(ORIGIN,[ID]),{code:'native_migration_profile_mismatch'});
});
test('symlinks, hardlinks, permissive mode and oversized sidecars fail closed without altering them',async t=>{
 const e=await fixture(t),target=path.join(e.dir,'target');fs.writeFileSync(target,'{}',{mode:0o600});fs.symlinkSync(target,e.sidecar);await assert.rejects(e.store.readNativeMigration(ORIGIN,[ID]),{code:'store_permissions'});fs.unlinkSync(e.sidecar);
 fs.linkSync(target,e.sidecar);await assert.rejects(e.store.readNativeMigration(ORIGIN,[ID]),{code:'store_permissions'});fs.unlinkSync(e.sidecar);
 e.write();fs.chmodSync(e.sidecar,0o644);await assert.rejects(e.store.readNativeMigration(ORIGIN,[ID]),{code:'store_permissions'});assert.equal(fs.statSync(e.sidecar).mode&0o777,0o644);
 fs.chmodSync(e.sidecar,0o600);fs.writeFileSync(e.sidecar,'x'.repeat(16385));await assert.rejects(e.store.readNativeMigration(ORIGIN,[ID]),{code:'native_migration_corrupt'});
});
test('schema, token, grant scope, expiration and malformed JSON are rejected',async t=>{
 const e=await fixture(t);for(const patch of [{schema_version:2},{token:'invalid'},{grant:{...GRANT,max_concurrent_agents:2}},{grant:{...GRANT,state:'revoked'}},{grant:{...GRANT,expires_at_ms:Date.now()-1}},{grant:{...GRANT,id:'bad'}},{extra:'untrusted'}]){e.write(patch);await assert.rejects(e.store.readNativeMigration(ORIGIN,[ID]),{code:'native_migration_corrupt'});}
 fs.writeFileSync(e.sidecar,'{');await assert.rejects(e.store.readNativeMigration(ORIGIN,[ID]),{code:'native_migration_corrupt'});
});
test('failed main write leaves sidecar available for retry and changed sidecar cannot be consumed',async t=>{
 const e=await fixture(t);e.write();const access=await e.store.readNativeMigration(ORIGIN,new Set([ID]));
 const write=e.store.write.bind(e.store);e.store.write=async()=>{throw Object.assign(new Error('isolated write failure'),{code:'store_write_failed'});};await assert.rejects(e.store.write({...e.original,native_access:access}));await assert.rejects(e.store.consumeNativeMigration(),{code:'native_migration_not_committed'});assert.ok(fs.existsSync(e.sidecar));e.store.write=write;
 await e.store.write({...e.original,native_access:access});e.write({token:'model_beta_'+'b'.repeat(43)});await assert.rejects(e.store.consumeNativeMigration(),{code:'native_migration_changed'});assert.ok(fs.existsSync(e.sidecar));
});
