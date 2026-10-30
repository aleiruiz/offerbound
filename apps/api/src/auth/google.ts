import { OAuth2Client } from "google-auth-library";

/** Exactly these four, never modify/send/compose (AC-2.1, SECURITY §7). */
export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/gmail.readonly",
];

export const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

export interface GoogleAuthClient {
  authUrl(p: {
    state: string;
    nonce: string;
    prompt: "consent" | "select_account";
    redirectUri: string;
  }): string;
  exchangeCode(
    code: string,
    redirectUri: string,
  ): Promise<{
    idToken: string;
    accessToken: string;
    refreshToken: string | null;
    expiresAt: Date;
    scopes: string[];
  }>;
  /** Verifies signature, `aud`, `iss`, `exp` and `nonce`; throws when any check fails. */
  verifyIdToken(
    idToken: string,
    nonce: string,
  ): Promise<{ sub: string; email: string; emailVerified: boolean }>;
  revoke(token: string): Promise<void>;
}

/** The real client wraps google-auth-library. Tests use a fake and never reach Google. */
export function createGoogleAuthClient(config: {
  clientId: string;
  clientSecret: string;
}): GoogleAuthClient {
  const oauth = (redirectUri?: string) =>
    new OAuth2Client({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      ...(redirectUri ? { redirectUri } : {}),
    });

  return {
    authUrl({ state, nonce, prompt, redirectUri }) {
      return oauth(redirectUri).generateAuthUrl({
        access_type: "offline",
        include_granted_scopes: true,
        scope: GOOGLE_SCOPES,
        prompt,
        state,
        nonce,
        redirect_uri: redirectUri,
      });
    },

    async exchangeCode(code, redirectUri) {
      const { tokens } = await oauth(redirectUri).getToken({ code, redirect_uri: redirectUri });
      if (!tokens.id_token || !tokens.access_token) {
        throw new Error("Google did not return the expected tokens");
      }
      return {
        idToken: tokens.id_token,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ? tokens.refresh_token : null,
        expiresAt: new Date(tokens.expiry_date ?? Date.now() + 3_600_000),
        scopes: (tokens.scope ?? "").split(/\s+/).filter((scope) => scope !== ""),
      };
    },

    async verifyIdToken(idToken, nonce) {
      // Checks the signature against Google's certificates, `iss`, `aud` and `exp`.
      const ticket = await oauth().verifyIdToken({ idToken, audience: config.clientId });
      const payload = ticket.getPayload();
      if (!payload) throw new Error("The id token has no payload");
      if (payload.nonce !== nonce) throw new Error("The id token nonce does not match");
      if (!payload.sub || !payload.email) throw new Error("The id token has no subject or email");
      return {
        sub: payload.sub,
        email: payload.email,
        emailVerified: payload.email_verified === true,
      };
    },

    async revoke(token) {
      await oauth().revokeToken(token);
    },
  };
}

/** Stand-in when Google is not configured (demo mode has no sign-in). */
export function createDisabledGoogleClient(): GoogleAuthClient {
  const unavailable = (): never => {
    throw new Error("Google sign-in is not configured");
  };
  return {
    authUrl: unavailable,
    exchangeCode: unavailable,
    verifyIdToken: unavailable,
    revoke: unavailable,
  };
}
