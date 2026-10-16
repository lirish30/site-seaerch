/** Wording for each way a sign-in can fail; only a 401 says the password itself is wrong. `status` is undefined when the request never got a response. */
export function loginErrorText(status: number | undefined): string {
  if (status === 401) return "Wrong password";
  if (status === 429) return "Too many attempts. Wait a minute and try again.";
  if (status === undefined) return "Couldn't reach the server. Check your connection and try again.";
  return "Sign-in failed. Please try again.";
}
