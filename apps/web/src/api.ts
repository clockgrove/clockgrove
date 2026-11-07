export interface BrowserSession {
  readonly credential: string;
}
/** Provider-neutral browser session boundary; session verification stays server-side. */
export interface BrowserAuthenticationPort {
  signIn(credential: string): Promise<BrowserSession>;
}
/** The local session credential is carried as entered; only the runtime verifies it. */
export const localSessionAuthentication: BrowserAuthenticationPort = {
  signIn: async (credential) => ({ credential }),
};
export class ApiRefusal extends Error {
  constructor(readonly status: number) {
    super(`Runtime request refused (${status})`);
  }
}
