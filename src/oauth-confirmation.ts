import { ConfirmationResult, connectionFetch, invalidConfirmation, pendingConfirmation, type ConfirmationAdapter } from './connection-confirmation.js';
import { z } from 'zod';

/** An existing opaque intent capability authorizes only its own receipt/claim. */
export function createOAuthConfirmation(options:{provider:'hubspot'|'slack'|'attio';origin:string;supabaseUrl:string;publishableKey:string;
  open:(state:string)=>string;complete:(input:{state:string;code:string})=>Promise<unknown>;fetchImpl?:typeof fetch}):ConfirmationAdapter {
  const fetchImpl=connectionFetch(options.fetchImpl??fetch);
  const Receipt= z.object({result:ConfirmationResult,claimed:z.boolean()});
  async function receipt(state:string, operation:'read'|'claim'|'deny') {
    const token=options.open(state);
    const response=await fetchImpl(`${options.supabaseUrl}/rest/v1/rpc/lifty_oauth_browser_attempt`,{
      method:'POST',redirect:'error',signal:AbortSignal.timeout(8000),
      headers:{apikey:options.publishableKey,'content-type':'application/json'},
      body:JSON.stringify({p_provider:options.provider,p_intent_token:token,p_operation:operation}),
    });
    if(!response.ok)throw new Error('receipt_unavailable');
    return Receipt.parse(await response.json());
  }
  return {
    origin:options.origin,
    validate(input){try{options.open(input.state);}catch{throw new SyntaxError('invalid_state');}},
    status:async input=>(await receipt(input.state,'read')).result,
    process:async input=>{
      if(input.denied)return (await receipt(input.state,'deny')).result;
      if(!input.code)return invalidConfirmation();
      const claim=await receipt(input.state,'claim');
      if(!claim.claimed)return claim.result;
      try{await options.complete({state:input.state,code:input.code});}
      catch{ // The persisted attempt is authoritative, including a lost store response.
        try{return (await receipt(input.state,'read')).result;}catch{return pendingConfirmation();}
      }
      return (await receipt(input.state,'read')).result;
    },
  };
}
