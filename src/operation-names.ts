// One callable name per canonical catalog operation.
export function operationToolNames(resource: string, action: string): string[] {
  return [resource === "summary" && action === "next_step" ? "next_step" : `${resource.replace(/-/g, "_")}_${action}`];
}
