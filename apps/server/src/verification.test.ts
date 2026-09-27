import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
process.env.NEXIOUS_DB_PATH=join(mkdtempSync(join(tmpdir(),"nexious-verification-")),"test.db");
process.env.NEXIOUS_DB_DRIVER="sqlite";
process.env.NEXIOUS_SQLITE_TEST="1";
const { db }=await import("./db.js");
const { tokenHash, nowIso }=await import("./auth.js");
const { consumeVerification, sendEmailCode, loadMailConfiguration }=await import("./verification.js");
after(()=>db.close());

test("邮件配置恢复父进程空变量，保留有效变量并遵循多个配置文件顺序",()=>{
  const directory=mkdtempSync(join(tmpdir(),"nexious-mail-env-"));
  const first=join(directory,"first.env"),last=join(directory,"last.env");
  writeFileSync(first,'RESEND_API_KEY=file-key\nRESEND_FROM="Nexious <no-reply@example.test>"\nPORT=9999\n');
  writeFileSync(last,'RESEND_API_KEY=last-file-key\nRESEND_REPLY_TO=reply@example.test\n');
  try{
    const environment:NodeJS.ProcessEnv={RESEND_API_KEY:"",RESEND_FROM:" ",RESEND_REPLY_TO:"existing@example.test",PORT:"8787"};
    loadMailConfiguration(["--env-file",first,`--env-file=${last}`,"--env-file-if-exists",join(directory,"absent.env")],environment);
    assert.equal(environment.RESEND_API_KEY,"last-file-key");
    assert.equal(environment.RESEND_FROM,"Nexious <no-reply@example.test>");
    assert.equal(environment.RESEND_REPLY_TO,"existing@example.test");
    assert.equal(environment.PORT,"8787");
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test("错误邮箱验证码尝试次数持久化，最多五次且成功后不可复用",async()=>{
  const insert=(id:string)=>db.prepare("INSERT INTO verification_challenges(id,purpose,subject,secret_hash,created_at,expires_at) VALUES(?,?,?,?,?,?)").run(id,"email-register","verified@example.test",tokenHash(`${id}:123456`),nowIso(),new Date(Date.now()+600000).toISOString());
  await insert("failed-code");
  for(let index=0;index<5;index++)await assert.rejects(()=>consumeVerification("failed-code","email-register","verified@example.test","000000"));
  assert.equal((await db.prepare("SELECT attempts FROM verification_challenges WHERE id='failed-code'").get())!.attempts,5);
  await assert.rejects(()=>consumeVerification("failed-code","email-register","verified@example.test","123456"));
  await insert("good-code");
  await assert.rejects(()=>consumeVerification("good-code","email-register","other@example.test","123456"));
  const results=await Promise.allSettled([1,2].map(()=>consumeVerification("good-code","email-register","verified@example.test","123456")));
  assert.equal(results.filter(result=>result.status==="fulfilled").length,1);
  await insert("expired-code");await db.prepare("UPDATE verification_challenges SET expires_at=? WHERE id='expired-code'").run(new Date(Date.now()-1).toISOString());
  await assert.rejects(()=>consumeVerification("expired-code","email-register","verified@example.test","123456"));
});

test("Resend 失败不会签发有效验证码，发送限流且不存明文验证码",async()=>{
  let failing=true,requests=0,delivered="";
  const server=createServer(async(req,res)=>{
    requests++;let body="";for await(const chunk of req)body+=chunk;
    assert.equal(req.headers.authorization,"Bearer test-mail-key");
    assert.ok(req.headers["idempotency-key"]);
    const value=JSON.parse(body);delivered=value.text.match(/\d{6}/)[0];
    res.writeHead(failing?403:200,{"content-type":"application/json"});res.end('{}');
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  process.env.RESEND_API_KEY="test-mail-key";process.env.RESEND_FROM="Nexious <no-reply@example.test>";process.env.RESEND_API_URL=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  try{
    await assert.rejects(()=>sendEmailCode("failed@example.test","register","failed@example.test","127.0.0.1"),/发送失败/);
    const failed=await db.prepare("SELECT * FROM verification_challenges WHERE subject='failed@example.test'").get();assert.equal(failed!.consumed,1);
    failing=false;
    const sent=await sendEmailCode("good@example.test","register","good@example.test","127.0.0.1");
    const row=await db.prepare("SELECT * FROM verification_challenges WHERE id=?").get(sent.verificationId);
    assert.notEqual(row!.secret_hash,delivered);assert.equal(row!.payload,null);
    await assert.rejects(()=>sendEmailCode("good@example.test","register","good@example.test","127.0.0.1"),/60 秒/);
    assert.equal(requests,2);
    await consumeVerification(sent.verificationId,"email-register","good@example.test",delivered);
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
