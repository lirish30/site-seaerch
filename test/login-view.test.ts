import { describe, expect, it } from "vitest";
import { loginErrorText } from "../src/client/loginView";

describe("loginView", () => {
  it("words each sign-in failure", () => {
    expect(loginErrorText(401)).toBe("Wrong password");
    expect(loginErrorText(429)).toBe("Too many attempts. Wait a minute and try again.");
    expect(loginErrorText(500)).toBe("Sign-in failed. Please try again.");
    expect(loginErrorText(undefined)).toBe("Couldn't reach the server. Check your connection and try again.");
  });
});
