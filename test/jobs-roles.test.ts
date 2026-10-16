import { describe, it, expect } from "vitest";
import { classifyRole } from "../src/worker/jobs/roles";

describe("classifyRole", () => {
  it.each([
    ["Senior SEO Manager", "seo"],
    ["Technical SEO Specialist", "seo"],
    ["Search Engine Optimization Lead", "seo"],
    ["Conversion Rate Optimization Specialist", "cro"],
    ["CRO Analyst", "cro"],
    ["Experimentation Manager", "cro"],
    ["Web Developer", "web_dev"],
    ["Front-End Engineer", "web_dev"],
    ["Frontend Developer (React)", "web_dev"],
    ["Senior WordPress Developer", "web_dev"],
    ["Shopify Engineer", "web_dev"],
    ["Webflow Designer", "web_dev"],
    ["Product Designer", "design"],
    ["UX Designer", "design"],
    ["Visual Designer", "design"],
    ["Growth Marketing Manager", "marketing"],
    ["Head of Growth", "marketing"],
    ["Digital Marketing Specialist", "marketing"],
    ["Product Marketing Manager", "marketing"],
    ["Paid Media Manager", "marketing"],
    ["PPC Specialist", "marketing"],
    ["Software Engineer, Full Stack", "web_dev"],
    ["Senior Software Engineer (Full-Stack)", "web_dev"],
    ["Web Development Manager", "web_dev"],
  ] as const)("%s -> %s", (title, kind) => expect(classifyRole(title)).toBe(kind));

  it.each(["Backend Engineer", "Senior Software Engineer", "Account Executive", "Crop Scientist", "Registered Nurse", "Accounts Payable Clerk", "Chief Revenue Officer (CRO)", "Clinical Trial Manager, CRO", ""])(
    "%s is outside the field", (title) => expect(classifyRole(title)).toBeNull());

  it("prefers the more specific kind when a title fits several", () => {
    expect(classifyRole("SEO Content Writer")).toBe("seo");
    expect(classifyRole("Marketing Web Developer")).toBe("web_dev");
  });
});
