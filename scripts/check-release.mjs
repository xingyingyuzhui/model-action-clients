import fs from 'node:fs';
const tag=process.env.RELEASE_TAG;
if(!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag??''))throw new Error('An existing version tag is required');
for(const name of ['model-action-mcp','dsh-model-action']){
  const pkg=JSON.parse(fs.readFileSync(new URL(`../packages/${name}/package.json`,import.meta.url),'utf8'));
  if(pkg.name!==name||pkg.version!==tag.slice(1))throw new Error('Package version does not match release tag: '+name);
}
