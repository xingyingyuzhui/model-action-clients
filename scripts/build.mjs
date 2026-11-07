import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const check=process.argv.includes('--check');
for(const relative of ['lib','packages/model-action-mcp/lib']){
  const target=path.join(root,relative);
  if(!check)fs.mkdirSync(target,{recursive:true});
  for(const file of ['client.js','runtime.js','store.js']){
    const source=fs.readFileSync(path.join(root,'shared',file));
    const output=path.join(target,file);
    if(check){if(!fs.existsSync(output)||!fs.readFileSync(output).equals(source))throw new Error('Generated library is stale: '+relative+'/'+file);}
    else fs.writeFileSync(output,source);
  }
}
console.log(check?'Bundled libraries match shared sources.':'Built both Model行动 packages from shared client sources.');
