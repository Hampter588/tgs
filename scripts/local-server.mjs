// Explicit local-only launcher. It never loads production credentials.
import {openDatabase} from '../server/db.mjs';
import {createApp} from '../server/app.mjs';
import {configFromEnv} from '../server/config.mjs';
import {hashPassword} from '../server/security.mjs';
import {randomBytes,randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
const db=openDatabase('data/local-tgs.sqlite');
const email='local-admin@tgs.invalid';
if(!db.prepare('SELECT 1 FROM users WHERE email=?').get(email)){
  const password=randomBytes(24).toString('base64url');
  db.prepare("INSERT INTO users(id,email,handle,name,password_hash,role,verified) VALUES(?,?,?,?,?,'admin',1)").run(randomUUID(),email,'local_admin','TGS Local Admin',await hashPassword(password));
  writeFileSync('../TGS-local-admin.txt',`TGS local development admin\nServer: http://127.0.0.1:3001\nEmail: ${email}\nPassword: ${password}\n\nThis account exists only in data/local-tgs.sqlite. Do not deploy this development database. Create a new production admin with npm run admin:create.\n`,{mode:0o600});
}
const config=configFromEnv({PUBLIC_URL:'http://127.0.0.1:3001'});
const app=createApp({db,config});
const server=app.listen(3001,'127.0.0.1',()=>console.log('Local TGS server: http://127.0.0.1:3001. Admin credentials are in ../TGS-local-admin.txt.'));
process.on('SIGTERM',()=>server.close(()=>{db.close();process.exit(0);}));
