/** Shared dependency-free browser Auth transport; never returns raw errors to UI. */
export const authBrowserScript = `
    function authErrorCode(payload) {
      if (typeof payload?.error_code === "string") return payload.error_code;
      if (typeof payload?.code === "string") return payload.code;
      if (Array.isArray(payload?.weak_password?.reasons) && payload.weak_password.reasons.length) return "weak_password";
      // Older Auth responses have numeric code and only a message. Match known
      // markers, never display their content (which can contain private data).
      const message = String(payload?.msg || payload?.message || "");
      if (/invalid.*login|invalid.*credential/i.test(message)) return "invalid_credentials";
      if (/signup.*disabled|signups?.*not.*allowed/i.test(message)) return "signup_disabled";
      return "unknown";
    }
    async function authRequest(pathname, { method = "POST", body, accessToken } = {}) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      try {
        const response = await fetch(config.supabaseUrl + pathname, {
          method, headers: { apikey: config.publishableKey, "content-type": "application/json",
            ...(accessToken ? { Authorization: "Bearer " + accessToken } : {}) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: controller.signal, redirect: "error", cache: "no-store",
          credentials: "omit", referrerPolicy: "no-referrer"
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw { kind: "auth", status: response.status, code: authErrorCode(payload) };
        return payload;
      } catch (error) {
        if (error?.kind === "auth") throw error;
        throw { kind: "network" };
      } finally { clearTimeout(timer); }
    }
    function safeAuthMessage(error, selectedMode) {
      const code = error?.code;
      if (error?.kind === "network" && selectedMode === "recovery-request") return "We couldn't confirm the recovery email request. Check your inbox before requesting another link.";
      if (error?.kind === "network") return "We couldn't reach the sign-in service. Check your connection and try again.";
      if (error?.status === 429 || ["over_request_rate_limit", "over_email_send_rate_limit"].includes(code)) return "Too many requests. Wait a minute before trying again.";
      if (error?.status >= 500) return "The sign-in service is temporarily unavailable. Try again later.";
      if (code === "invalid_credentials") return "The email or password is incorrect.";
      if (code === "signup_disabled") return "New accounts are invite-only. Ask LIFT for an invite, then sign in here.";
      if (["user_already_exists", "email_exists"].includes(code) && selectedMode === "create") return "That email already has an account. Sign in instead.";
      if (code === "email_not_confirmed") return "Confirm your account using its existing confirmation email, then sign in again.";
      if (code === "weak_password") return "Choose a stronger password with at least 8 characters. Follow any password requirements for your account.";
      if (code === "same_password") return "Choose a password different from your current password.";
      if (code === "reauthentication_needed") return "This session needs a fresh recovery link. Request another email and open its newest link.";
      if (selectedMode === "password-update" || selectedMode === "validate") {
        if ([401, 403].includes(error?.status) || ["otp_expired", "bad_jwt", "session_not_found", "user_not_found"].includes(code)) return "This recovery link is invalid, expired, or already used. Request a new link.";
        return "We couldn't change the password. Request a fresh recovery link and try again.";
      }
      if (selectedMode === "recovery-request") return "We couldn't request the recovery email. Try again later.";
      return selectedMode === "sign-in" ? "We couldn't sign you in. Try again." : "We couldn't create the account. Try again.";
    }
`;
