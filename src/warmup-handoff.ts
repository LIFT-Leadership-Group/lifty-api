export type WarmupRefusal = "mailbox_in_other_warmup" | "provider_rejected";

/** HTTP refusal is authoritative even if its bounded, untrusted body is unreadable.
 * Only the mapped code leaves this function. Success/uncertain bodies are discarded. */
export async function warmupHandoffRefusal(response: Response): Promise<WarmupRefusal | null> {
  if (response.status < 400 || response.status >= 500 || response.status === 408) {
    void response.body?.cancel().catch(() => {});
    return null;
  }
  const reader = response.body?.getReader();
  if (!reader) return "provider_rejected";
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error()), 2000); });
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const chunk = await Promise.race([reader.read(), expired]);
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 16384) return "provider_rejected";
      chunks.push(chunk.value);
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (value && typeof value === "object" && "success" in value && value.success === false
      && "error" in value && value.error && typeof value.error === "object" && "email" in value.error) {
      const email = value.error.email;
      const errors: unknown[] = Array.isArray(email) ? email : [email];
      if (errors.some(error => typeof error === "string" && error.trim().toLowerCase() === "the email has already been taken."))
        return "mailbox_in_other_warmup";
    }
  } catch { /* Provider text, parsing and transport exceptions never escape. */ }
  finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return "provider_rejected";
}
