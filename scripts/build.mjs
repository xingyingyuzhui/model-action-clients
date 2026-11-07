import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
for(const name of ['model-action-mcp','dsh-model-action']){
  const target=path.join(root,'packages',name,'lib');
  fs.mkdirSync(target,{recursive:true});
  for(const file of ['client.js','runtime.js','store.js']) fs.copyFileSync(path.join(root,'shared',file),path.join(target,file));
}
console.log('Built both Model行动 packages from shared client sources.');
