import type { GoogleAuthClient } from "../src/auth/google.js";
import { GOOGLE_SCOPES } from "../src/auth/google.js";

type Exchange = Awaited<ReturnType<GoogleAuthClient["exchangeCode"]>>;
type Identity = Awaited<ReturnType<GoogleAuthClient["verifyIdToken"]>>;
type AuthUrlParams = Parameters<GoogleAuthClient["authUrl"]>[0];

/** The identity the fake "signs in" as unless a test changes it. Fictional. */
export const FAKE_OWNER_IDENTITY: Identity = {
  sub: "google-sub-owner",
  email: "owner@example.com",
  emailVerified: true,
};

/**
 * A scriptable GoogleAuthClient. It never touches the network. Tests set `exchange` and
 * `identity` before calling the callback and read the recorded calls afterwards.
 */
export class FakeGoogleAuthClient implements GoogleAuthClient {
  exchange: Exchange = {
    idToken: "fake-id-token",
    accessToken: "fake-access-token",
    refreshToken: "fake-refresh-token",
    expiresAt: new Date("2026-10-01T13:00:00.000Z"),
    scopes: [...GOOGLE_SCOPES],
  };
  identity: Identity = { ...FAKE_OWNER_IDENTITY };
  authUrls: AuthUrlParams[] = [];
  exchanged: { code: string; redirectUri: string }[] = [];
  verified: { idToken: string; nonce: string }[] = [];
  revoked: string[] = [];

  authUrl(params: AuthUrlParams): string {
    this.authUrls.push(params);
    const url = new URL("https://accounts.google.example/o/oauth2/v2/auth");
    url.searchParams.set("state", params.state);
    url.searchParams.set("prompt", params.prompt);
    return url.toString();
  }

  exchangeCode(code: string, redirectUri: string): Promise<Exchange> {
    this.exchanged.push({ code, redirectUri });
    return Promise.resolve({ ...this.exchange, scopes: [...this.exchange.scopes] });
  }

  verifyIdToken(idToken: string, nonce: string): Promise<Identity> {
    this.verified.push({ idToken, nonce });
    return Promise.resolve({ ...this.identity });
  }

  revoke(token: string): Promise<void> {
    this.revoked.push(token);
    return Promise.resolve();
  }
}
