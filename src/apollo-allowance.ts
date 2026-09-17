import { z } from "zod";
import type { AuthSession } from "./app.js";
import { PublicError } from "./errors.js";
export const ApolloAllowanceSchema=z.object({
 workspace_ref:z.uuid(),lifty:z.boolean(),applies:z.boolean(),key_source:z.enum(["platform_default","own_key","unconfigured"]),
 limit:z.number().int().nonnegative().nullable(),used:z.number().int().nonnegative(),reserved:z.number().int().nonnegative(),
 remaining:z.number().int().nonnegative().nullable(),resets_at:z.string().datetime({offset:true}),
});
export type ApolloAllowance=z.infer<typeof ApolloAllowanceSchema>;
export async function getApolloAllowance(session:AuthSession,workspace:string):Promise<ApolloAllowance>{
 const id=z.uuid().parse(workspace);
 const client=session.client as {rpc(name:string,args:Record<string,unknown>):Promise<{data:unknown;error:unknown}>};
 const {data,error}=await client.rpc("get_lifty_apollo_allowance",{p_workspace_id:id});
 const errorShape=z.object({message:z.string().optional()}).safeParse(error);
 if(errorShape.success&&errorShape.data.message==="lifty_workspace_forbidden")throw new PublicError({status:403,code:"WORKSPACE_FORBIDDEN",message:"Choose a workspace you belong to."});
 const parsed=ApolloAllowanceSchema.safeParse(data);
 if(error||!parsed.success||parsed.data.workspace_ref!==id||(parsed.data.applies ? (parsed.data.limit===null||parsed.data.remaining!==Math.max(0,parsed.data.limit-parsed.data.used-parsed.data.reserved)) : (parsed.data.limit!==null||parsed.data.remaining!==null)))throw new PublicError({status:502,code:"APOLLO_ALLOWANCE_UNAVAILABLE",message:"LIFTY could not verify the weekly Apollo allowance. Try again later."});
 return parsed.data;
}
