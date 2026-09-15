import { beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createGoogleMailboxProofVerifier } from "../src/google-mailbox-proof.js";
const now = new Date("2026-09-15T12:00:00Z");
const clientId = "fixture.apps.googleusercontent.com";
const accessToken = "fake-access-token-for-unit-tests";
const nonce = "fixture-nonce-with-sufficient-entropy";
const context = { grantRef:"10000000-0000-4000-8000-000000000001", intentRef:"10000000-0000-4000-8000-000000000002", workspaceRef:"10000000-0000-4000-8000-000000000003", nonce, expectedEmail:"owner@example.test" };
const atHash = createHash("sha256").update(accessToken).digest().subarray(0,16).toString("base64url");
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let verify: ReturnType<typeof createGoogleMailboxProofVerifier>;
async function token(overrides: Record<string,unknown> = {}) {
  return new SignJWT({iss:"https://accounts.google.com",aud:clientId,sub:"StableCaseSensitiveSubject",iat:Math.floor(now.getTime()/1000),exp:Math.floor(now.getTime()/1000)+3600,nonce,at_hash:atHash,email:"owner@example.test",email_verified:true,hd:"example.test",...overrides})
    .setProtectedHeader({alg:"RS256",kid:"fixture"}).sign(keys.privateKey);
}
beforeAll(async()=>{
  keys=await generateKeyPair("RS256");
  const jwk=await exportJWK(keys.publicKey);
  verify=createGoogleMailboxProofVerifier({clientId,keySet:createLocalJWKSet({keys:[{...jwk,kid:"fixture",alg:"RS256"}]}),now:()=>now});
});
describe("same-grant Google mailbox identity",()=>{
  it("binds stable subject and exact access token to persisted context without retaining secrets",async()=>{
    const idToken=await token();
    const result=await verify({idToken,accessToken},context);
    expect(result).toMatchObject({issuer:"https://accounts.google.com",subject:"StableCaseSensitiveSubject",email:"owner@example.test",clientId,grantRef:context.grantRef,intentRef:context.intentRef,workspaceRef:context.workspaceRef});
    expect(result.accessTokenSha256).toBe(createHash("sha256").update(accessToken).digest("hex"));
    expect(result.idTokenSha256).toBe(createHash("sha256").update(idToken).digest("hex"));
    expect(result.nonceSha256).toBe(createHash("sha256").update(nonce).digest("hex"));
    for(const secret of [accessToken,idToken,nonce]) expect(JSON.stringify(result)).not.toContain(secret);
  });
  it("normalizes only Google's documented issuer and keeps subject through primary rename",async()=>{
    const result=await verify({idToken:await token({iss:"accounts.google.com",email:"renamed@example.test"}),accessToken},{...context,expectedEmail:"renamed@example.test"});
    expect(result.issuer).toBe("https://accounts.google.com");
    expect(result.subject).toBe("StableCaseSensitiveSubject");
  });
  it("accepts a verified Gmail address without Workspace hd",async()=>{
    expect((await verify({idToken:await token({email:"owner@gmail.com",hd:undefined}),accessToken},{...context,expectedEmail:"owner@gmail.com"})).email).toBe("owner@gmail.com");
  });
  it.each([
    {iss:"https://attacker.test"},{aud:"another-client"},{aud:[clientId,"another-client"]},{nonce:"wrong"},{sub:""},{sub:"a\n"},{sub:"x".repeat(256)},{email_verified:false},{email_verified:"true"},{email:"wrong@example.test"},{hd:undefined},{azp:"another-client"},{at_hash:"wrong"},{at_hash:undefined},{exp:Math.floor(now.getTime()/1000)-60},{iat:Math.floor(now.getTime()/1000)+120},{iat:undefined},
  ])("rejects incompatible claims without leaking tokens %j",async claims=>{
    await expect(verify({idToken:await token(claims),accessToken},context)).rejects.toThrow("Google mailbox identity could not be verified.");
  });
  it("rejects access-token substitution",async()=>{
    await expect(verify({idToken:await token(),accessToken:"different"},context)).rejects.toThrow("Google mailbox identity could not be verified.");
  });
  it("rejects a token signed by another key",async()=>{
    const alien=await generateKeyPair("RS256");
    const idToken=await new SignJWT({}).setProtectedHeader({alg:"RS256",kid:"fixture"}).sign(alien.privateKey);
    await expect(verify({idToken,accessToken},context)).rejects.toThrow("Google mailbox identity could not be verified.");
  });
  it("requires bounded persisted correlation context",async()=>{
    await expect(verify({idToken:await token(),accessToken},{...context,nonce:""})).rejects.toThrow("Google mailbox identity could not be verified.");
  });
  it("rejects missing configuration at construction",()=>{
    expect(()=>createGoogleMailboxProofVerifier({clientId:""})).toThrow("Invalid Google client configuration.");
  });
});
