export interface VerificationRequest { resolve:()=>void;reject:(error:Error)=>void }
let pending:Promise<void>|null=null;
export function requestReauthentication():Promise<void> {
  if(pending)return pending;
  pending=new Promise<void>((resolve,reject)=>window.dispatchEvent(new CustomEvent<VerificationRequest>("nexious-verify-identity",{detail:{resolve,reject}}))).finally(()=>{pending=null;});
  return pending;
}
