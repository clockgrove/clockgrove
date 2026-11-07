/** Detect raw external subjects and auth-provider types in inward source vocabulary. */
export const forbiddenAuthVocabulary = [
  /\b(?:ExternalIdentityRef|ProviderSubject(?:Id)?|providerSubject(?:Id)?|providerUserId|externalSubject(?:Id)?)\b/iu,
  /\b(?:BetterAuth|ClerkUser|Auth0User|SupabaseUser)\b/u,
  /(?:from\s*|import\s*\()["'](?:better-auth|@clerk\/|@auth0\/|@supabase\/)/u,
  /\bprovider\s*:\s*string\b[\s\S]*?\bsubject\s*:\s*string\b/u,
];

export function assertAuthProviderNeutral(source, location) {
  if (forbiddenAuthVocabulary.some((pattern) => pattern.test(source))) {
    throw new Error(`${location}: provider-specific authentication vocabulary is forbidden`);
  }
}
