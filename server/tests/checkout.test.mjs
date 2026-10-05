import {test} from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {openDatabase} from '../db.mjs';
import {createApp} from '../app.mjs';
import {configFromEnv} from '../config.mjs';
test('checkout concurrency reuses one session and a canceled member can resubscribe',async()=>{
  const db=openDatabase(':memory:');let created=0,status='open',subStatus='active';
  const stripe={customers:{create:async()=>({id:'cus_user'})},checkout:{sessions:{create:async()=>({id:`cs_${++created}`,url:'https://checkout.stripe.com/test',status:'open',expires_at:Math.floor(Date.now()/1000)+86400}),retrieve:async()=>({id:'cs_1',url:'https://checkout.stripe.com/test',status,subscription:status==='complete'?'sub_user':null})}},subscriptions:{retrieve:async()=>({id:'sub_user',customer:'cus_user',status:subStatus,cancel_at_period_end:false,items:{data:[{price:{id:'price_month'},current_period_end:Math.floor(Date.now()/1000)+3600}]}})}};
  const config={...configFromEnv({}),stripeSecret:'test',webhookSecret:'test',monthlyPrice:'price_month',yearlyPrice:'price_year'};
  const app=createApp({db,config,stripeClient:stripe,disableRateLimits:true});
  try{
    const account=await request(app).post('/api/auth/register').set('X-TGS-Client','1').send({email:'user@example.com',handle:'user',name:'User',password:'A secure test password 42!'});
    const checkout=()=>request(app).post('/api/billing/checkout').set('X-TGS-Client','1').set('Authorization',`Bearer ${account.body.token}`).send({interval:'month'});
    const replies=await Promise.all([checkout(),checkout()]);assert.deepEqual(replies.map(r=>r.status),[200,200]);assert.equal(created,1);
    status='complete';assert.equal((await checkout()).status,409);assert.equal(created,1);
    db.prepare("UPDATE subscriptions SET status='canceled'").run();subStatus='canceled';assert.equal((await checkout()).status,200);assert.equal(created,2);
  }finally{db.close();}
});
