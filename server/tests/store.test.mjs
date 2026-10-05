import {test} from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {openDatabase} from '../db.mjs';
import {reconcileStore} from '../revenuecat.mjs';
import {isPlus} from '../billing.mjs';
import {configFromEnv} from '../config.mjs';
import {createApp} from '../app.mjs';
const expiry=new Date(Date.now()+86400000).toISOString();
function setup(){const db=openDatabase(':memory:');db.prepare('INSERT INTO users(id,email,handle,name,password_hash,verified) VALUES(?,?,?,?,?,1)').run('user','user@example.com','user','User','not-a-real-password');const config={...configFromEnv({}),rcSecret:'secret',rcWebhook:'Bearer webhook-secret',rcEntitlement:'tgs_plus',production:true};return{db,config};}
function response({sandbox=false,expires=expiry,refunded=false}={}){return {ok:true,json:async()=>({subscriber:{entitlements:{tgs_plus:{expires_date:expires,product_identifier:'monthly'}},subscriptions:{monthly:{is_sandbox:sandbox,refunded_at:refunded?expiry:null}}}})};}
test('native Plus is verified with the provider and production rejects sandbox purchases',async()=>{const {db,config}=setup();try{await reconcileStore(db,config,'user',async()=>response());assert.equal(isPlus(db,'user'),true);await reconcileStore(db,config,'user',async()=>response({sandbox:true}));assert.equal(isPlus(db,'user'),false);await reconcileStore(db,config,'user',async()=>response({expires:'2000-01-01T00:00:00Z'}));assert.equal(isPlus(db,'user'),false);await reconcileStore(db,config,'user',async()=>response({refunded:true}));assert.equal(isPlus(db,'user'),false);}finally{db.close();}});
test('store webhooks require authorization, are replay-safe, and ignore anonymous IDs',async()=>{const {db,config}=setup();let calls=0;const app=createApp({db,config,disableRateLimits:true,storeFetch:async()=>{calls++;return response();}});try{const body={event:{id:'event',app_user_id:'user',aliases:['$RCAnonymousID:unmapped']}};assert.equal((await request(app).post('/api/billing/store-webhook').send(body)).status,401);assert.equal((await request(app).post('/api/billing/store-webhook').set('Authorization',config.rcWebhook).send(body)).status,200);assert.equal(isPlus(db,'user'),true);await request(app).post('/api/billing/store-webhook').set('Authorization',config.rcWebhook).send(body);assert.equal(calls,1);}finally{db.close();}});
