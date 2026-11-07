import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const output=path.join(root,'dist');fs.mkdirSync(output,{recursive:true});
const results=[];
for(const name of ['model-action-mcp','dsh-model-action']){
  const cwd=name==='dsh-model-action'?root:path.join(root,'packages',name);
  const [packed]=JSON.parse(execFileSync('npm',['pack','--json','--ignore-scripts','--pack-destination',output],{cwd,encoding:'utf8'}));
  const file=path.join(output,packed.filename);
  if(packed.files.some(f=> /(?:^|\/)(?:node_modules|test|evidence|\.env|secrets\.local\.json)(?:\/|$)/.test(f.path)))throw new Error('Unexpected private/test material in '+name);
  results.push({name,version:packed.version,filename:packed.filename,sha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),integrity:packed.integrity,files:packed.files.map(f=>f.path)});
}
fs.writeFileSync(path.join(output,'manifest.json'),JSON.stringify(results,null,2)+'\n');
fs.writeFileSync(path.join(output,'SHA256SUMS'),results.map(r=>r.sha256+'  '+r.filename).join('\n')+'\n');
console.log(JSON.stringify(results.map(({name,filename,sha256})=>({name,filename,sha256})),null,2));
