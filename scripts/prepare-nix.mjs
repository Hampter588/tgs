import {mkdirSync,cpSync,copyFileSync} from 'node:fs';
const destination='work/nix-source';
mkdirSync(destination,{recursive:true});
for(const directory of ['dist','electron'])cpSync(directory,`${destination}/${directory}`,{recursive:true});
for(const file of ['package.json','flake.nix'])copyFileSync(file,`${destination}/${file}`);
console.log('Nix source prepared at work/nix-source without databases, credentials, or node_modules.');
