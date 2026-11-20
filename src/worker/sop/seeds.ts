import type { MilestoneKey, OwnerTag, SopStep, SopTemplateInput } from "./model";

/**
 * The built-in SOP templates, inserted by `ensureSeedSops` when missing and then Logan's to edit in Settings.
 * The text is written fresh: titles say what to do, "done when" says how you can tell it is done, and a client summary is what the client sees.
 */

interface S {
  key: string;
  title: string;
  owner: OwnerTag;
  /** Estimated minutes. */
  est: number;
  /** Done when. */
  done: string;
  requires?: string[];
  milestone?: MilestoneKey;
  /** What the client sees while this step is the current one (80 characters or less). */
  say?: string;
  skippable?: boolean;
}
interface Phase { key: string; title: string; steps: S[] }

const C: OwnerTag = "claude";
const L: OwnerTag = "logan";
const CL: OwnerTag = "claude_drafts";

/** Flattens phases into steps with positions that rise through the whole template. */
function stepsOf(phases: Phase[]): SopStep[] {
  const out: SopStep[] = [];
  for (const p of phases) {
    for (const s of p.steps) {
      out.push({
        key: s.key, phaseKey: p.key, phaseTitle: p.title, position: out.length + 1, title: s.title, owner: s.owner, estMinutes: s.est, doneWhen: s.done,
        docTemplate: null, emailTemplate: null, requires: s.requires ?? [], milestone: s.milestone ?? null, clientSummary: s.say ?? null, skippable: s.skippable ?? false,
      });
    }
  }
  return out;
}

const QA_STEPS = ["6.1", "6.2", "6.3", "6.4", "6.5", "6.6", "6.7", "6.8", "6.9"];

const BUILD: SopTemplateInput = {
  key: "BUILD",
  name: "Website build",
  kind: "project",
  cadence: null,
  cadenceDay: null,
  appliesTo: ["starter_site", "growth_site", "website_subscription"],
  active: true,
  steps: stepsOf([
    {
      key: "collect", title: "Collect", steps: [
        { key: "1.1", title: "Onboarding collected", owner: L, est: 5, done: "The questionnaire is in, and the logo, photos and text are received or marked not needed.", say: "We have what we need from you to start" },
        { key: "1.2", title: "Get access to the accounts", owner: CL, est: 15, done: "Domain, DNS, hosting, Google profile and analytics access are all in, and the notes name the password manager item for each, never the login itself." },
        { key: "1.3", title: "Turn the answers into a project brief", owner: CL, est: 20, done: "The brief covers goals, audience, main action and keywords, and Logan has approved it.", requires: ["1.1"] },
        { key: "1.4", title: "Write the brand style sheet", owner: CL, est: 20, done: "Colors (with hex codes) and fonts are written down, and the client has confirmed them if they care.", requires: ["1.1"] },
        { key: "1.5", title: "Pick the calls to action", owner: CL, est: 30, done: "One main and one backup call to action are chosen after a look at what competitors use.", requires: ["1.3"] },
        { key: "1.6", title: "Prepare the client's images", owner: C, est: 20, done: "Web-ready copies are in the folder with clear file names and draft alt text, and the originals are untouched.", requires: ["1.1"] },
      ],
    },
    {
      key: "plan", title: "Plan", steps: [
        { key: "2.1", title: "Draft the sitemap and page list", owner: CL, est: 25, done: "Menu of six or seven items with the call to action last, and each page has a keyword and a purpose. Logan approved it.", requires: ["1.3", "1.5"], say: "We're mapping out your pages" },
        { key: "2.2", title: "Get the client's OK on the sitemap", owner: L, est: 10, done: "The client's OK is written down. Skip it for a small site and a relaxed client.", requires: ["2.1"], skippable: true },
        { key: "2.3", title: "Sketch the header and home page", owner: CL, est: 20, done: "A rough outline of the header and the home page layout is approved by Logan.", requires: ["2.1"] },
        { key: "2.4", title: "Draft the page copy", owner: CL, est: 60, done: "Copy and meta text for each page are in the review doc, with any gaps flagged.", requires: ["2.1"] },
      ],
    },
    {
      key: "design", title: "Design", steps: [
        { key: "3.1", title: "Set up the working site", owner: CL, est: 30, done: "The working site loads over HTTPS, search engines are blocked, and forms are ready to be wired up.", requires: ["1.2"] },
        { key: "3.2", title: "Set the global styles", owner: C, est: 30, done: "Colors, type sizes, buttons, logo and favicon are in, and the style guide page matches the brand sheet.", requires: ["3.1", "1.4"] },
        { key: "3.3", title: "Build the menu, header and footer", owner: CL, est: 60, done: "Logan has looked over the header and footer.", requires: ["3.2"] },
        { key: "3.4", title: "Build the home page and one or two inner pages", owner: CL, est: 120, done: "The home page and one or two inner pages use real copy where we have it. Logan approves them for the preview. Phone layout is not needed yet.", requires: ["3.3", "2.3", "2.4"], say: "We're designing your home page" },
        { key: "3.5", title: "Check the design before it goes out", owner: C, est: 15, done: "The call to action shows without scrolling, contrast is fine, the menu works and the look matches the brand sheet.", requires: ["3.4"] },
      ],
    },
    {
      key: "initial_review", title: "Initial review", steps: [
        { key: "4.1", title: "Record the walkthrough video", owner: L, est: 15, done: "The video runs five minutes or less, explains why the design looks this way, and the link works.", requires: ["3.5"] },
        { key: "4.2", title: "Draft the preview email", owner: CL, est: 10, done: "The email is approved and sent, and it says what happens next for both sides.", requires: ["4.1"], say: "Your design preview is ready to look at" },
        { key: "4.3", title: "Turn the client's feedback into a task list", owner: C, est: 10, done: "Every comment from the client is a task, or the client has said there are no changes.", requires: ["4.2"] },
        { key: "4.4", title: "Make the revisions", owner: CL, est: 60, done: "Every revision task is closed.", requires: ["4.3"], say: "We're making the changes you asked for" },
        { key: "4.5", title: "Client OK on the design direction", owner: L, est: 10, done: "The client's written OK on the design is logged.", requires: ["4.4"], milestone: "design_approved", say: "We need your OK on the design" },
      ],
    },
    {
      key: "build_out", title: "Build out", steps: [
        { key: "5.1", title: "Fix the shared parts for phones", owner: C, est: 20, done: "Header, hero and call to action look right at phone width before any page is copied.", requires: ["4.5"] },
        { key: "5.2", title: "Build the forms and thank-you pages", owner: C, est: 30, done: "A test submission from the working site reaches the client's inbox.", requires: ["5.1"] },
        { key: "5.3", title: "Build the rest of the pages", owner: CL, est: 120, done: "Every page on the sitemap exists.", requires: ["5.1"], say: "We're building the rest of your pages" },
        { key: "5.4", title: "Add the page-level SEO", owner: CL, est: 60, done: "Each page has a title, description, headings, image alt text, internal links and the right schema.", requires: ["5.3"] },
        { key: "5.5", title: "Add the extras the client bought", owner: CL, est: 45, done: "Each booking tool, review widget, map or call tracker works.", requires: ["5.3"], skippable: true },
        { key: "5.6", title: "Save the reusable templates", owner: C, est: 20, done: "Page and section templates are saved for the next site.", requires: ["5.3"] },
      ],
    },
    {
      key: "qa", title: "QA and final review", steps: [
        { key: "6.1", title: "Set up the site's outgoing email", owner: CL, est: 30, done: "A test email passes the sender checks.", requires: ["5.2"] },
        { key: "6.2", title: "Test every form", owner: CL, est: 20, done: "Test sends from different addresses reach the inbox, not spam, and the client has confirmed they got one.", requires: ["6.1"], say: "We're testing your contact forms" },
        { key: "6.3", title: "Check phone, tablet and desktop", owner: C, est: 30, done: "Screens at 375, 768 and 1280 wide are looked at and nothing is off.", requires: ["5.3"] },
        { key: "6.4", title: "Check the main browsers", owner: C, est: 20, done: "Chrome, Safari, Firefox and Edge show no layout problems.", requires: ["5.3"] },
        { key: "6.5", title: "Run the speed, accessibility and SEO checks", owner: C, est: 20, done: "Scores meet the targets, or each miss is written down with a reason.", requires: ["5.4"] },
        { key: "6.6", title: "Proofread everything", owner: CL, est: 30, done: "No placeholder text is left, hours, prices and contact details are right, and Logan has signed off.", requires: ["5.3"] },
        { key: "6.7", title: "Make the share image", owner: C, est: 15, done: "The home page share preview renders correctly.", requires: ["5.3"] },
        { key: "6.8", title: "Final review and the client's OK to launch", owner: L, est: 10, done: "The final review went out early or mid-week and the client's OK to launch is logged.", requires: ["6.1", "6.2", "6.3", "6.4", "6.5", "6.6", "6.7"], milestone: "site_finished", say: "Your final review is with you" },
        { key: "6.9", title: "Apply the final changes", owner: CL, est: 45, done: "The last changes are closed, and forms, phone layout and proofreading are rechecked on the pages that changed.", requires: ["6.8"] },
      ],
    },
    {
      key: "launch", title: "Launch", steps: [
        { key: "7.1", title: "Set up the client's login and clean up", owner: C, est: 20, done: "The client's login works with the lowest role that does the job, and unused plugins and media are gone.", requires: ["6.9"] },
        { key: "7.2", title: "Take a full backup", owner: C, est: 15, done: "Files and database are saved to the backups folder and the restore point is checked.", requires: ["7.1"] },
        { key: "7.3", title: "Pick a Friday launch date", owner: L, est: 15, done: "The client agrees the Friday, and the domain and hosting plan are confirmed.", requires: ["6.8"] },
        { key: "7.4", title: "Go live", owner: L, est: 60, done: "The real addresses load, old addresses redirect, and search engines are allowed in.", requires: [...QA_STEPS, "7.2"], say: "Your site is going live" },
        { key: "7.5", title: "Test the live site", owner: CL, est: 20, done: "Forms, phone links and booking all work on the live site.", requires: ["7.4"] },
        { key: "7.6", title: "Set up analytics and Search Console", owner: CL, est: 30, done: "Analytics shows a live visit, then Search Console is verified and the sitemap is accepted.", requires: ["7.4"], say: "We're setting up your visitor tracking" },
        { key: "7.7", title: "Update the Google business profile", owner: CL, est: 30, done: "The profile's name, address and phone match the site.", requires: ["7.4"], skippable: true },
      ],
    },
    {
      key: "handoff", title: "Handoff", steps: [
        { key: "8.1", title: "Record a short how-to", owner: CL, est: 45, done: "A short video and written steps for editing text, forms and who to call are delivered, and the client says they got them.", requires: ["7.4"], say: "Your how-to video is on the way" },
        { key: "8.2", title: "Send the handoff email", owner: CL, est: 20, done: "The email is sent with the addresses, who owns each login, what is included and how to get help.", requires: ["7.5"], say: "Your handoff email is on the way" },
        { key: "8.3", title: "Remove the working site", owner: CL, est: 20, done: "The old working address shows not found and no stray folders are left. Do this about a week after launch.", requires: ["7.5"] },
        { key: "8.4", title: "Tidy the project files and write notes", owner: C, est: 15, done: "Folders are tidy, source files are archived and notes on what went well and badly are saved to the project.", requires: ["7.5"] },
        { key: "8.5", title: "Collect the final payment and close out", owner: L, est: 15, done: "The final invoice is paid, the project is closed and a review is requested.", requires: ["8.2"] },
      ],
    },
    {
      key: "care_offer", title: "Care offer", steps: [
        { key: "9.1", title: "Offer a Care plan", owner: CL, est: 15, done: "A Care proposal is sent, or the client's no is logged.", requires: ["7.4"] },
        { key: "9.2", title: "Do the 30-day check-in", owner: CL, est: 20, done: "An email went out with a traffic snapshot, a form check and a look at reviews, and any follow-ups are tasks.", requires: ["7.4"] },
        { key: "9.3", title: "Book the 90-day SEO check", owner: CL, est: 10, done: "A reminder task exists for 90 days after launch.", requires: ["7.4"] },
      ],
    },
  ]),
};

const QUICKFIX: SopTemplateInput = {
  key: "QUICKFIX",
  name: "Quick fix",
  kind: "project",
  cadence: null,
  cadenceDay: null,
  appliesTo: ["quick_fix"],
  active: true,
  steps: stepsOf([
    {
      key: "fix", title: "Fix", steps: [
        { key: "1.1", title: "Confirm the fix list", owner: CL, est: 15, done: "The list of fixes is written down and the client has agreed to it.", say: "We're confirming your list of fixes" },
        { key: "1.2", title: "Get access to the site", owner: CL, est: 10, done: "Access works, and the notes say where the login is kept, never the login itself." },
        { key: "1.3", title: "Back up the site", owner: C, est: 10, done: "A full backup is saved and a restore point exists.", requires: ["1.2"] },
        { key: "1.4", title: "Make the fixes", owner: CL, est: 60, done: "Every item on the list is fixed, or noted as not possible and why.", requires: ["1.1", "1.3"], say: "We're making your fixes" },
        { key: "1.5", title: "Test the changes", owner: C, est: 20, done: "Each fix works, and forms and the main pages still work on phone and desktop.", requires: ["1.4"] },
        { key: "1.6", title: "Show before and after", owner: C, est: 10, done: "Each fix has a before picture and an after picture.", requires: ["1.5"], say: "Your before and after is ready" },
        { key: "1.7", title: "Get the client's OK", owner: L, est: 10, done: "The client has said in writing that the fixes look right.", requires: ["1.6"] },
        { key: "1.8", title: "Close the job and ask for a review", owner: L, est: 10, done: "The final invoice is paid, a review is requested and the project is closed.", requires: ["1.7"] },
      ],
    },
  ]),
};

const CARE_0: SopTemplateInput = {
  key: "CARE-0",
  name: "Care onboarding",
  kind: "project",
  cadence: null,
  cadenceDay: null,
  appliesTo: ["care", "care_plus", "care_fallback"],
  active: true,
  steps: stepsOf([
    {
      key: "setup", title: "Set up Care", steps: [
        { key: "1.1", title: "Collect access", owner: L, est: 10, done: "Hosting, admin, analytics, search and domain contacts are in, and the notes say which password manager item holds each login.", say: "We're getting access to your site" },
        { key: "1.2", title: "Create the site record", owner: CL, est: 5, done: "The record has plan, price, billing cycle, key dates, contacts, host and main software, and it saves without errors." },
        { key: "1.3", title: "Connect monitoring", owner: C, est: 10, done: "Uptime, certificate and domain expiry, backups, security alerts and the analytics and search links each report a first good check.", requires: ["1.1"] },
        { key: "1.4", title: "Take a baseline backup", owner: C, est: 10, done: "A full backup is saved off the server and a test restore on a copy passes.", requires: ["1.3"] },
        { key: "1.5", title: "Run a baseline update pass", owner: CL, est: 20, done: "Updates went onto a test copy first, pages and forms still work, then the live site. The log is saved.", requires: ["1.4"] },
        { key: "1.6", title: "Run a baseline health scan", owner: C, est: 10, done: "Speed, broken links, indexing, security, certificate, form delivery and click-to-call are checked, and each issue is sorted into fix now, quote, or ignore.", requires: ["1.5"] },
        { key: "1.7", title: "Add the privacy policy widget", owner: C, est: 5, done: "If the plan includes it, the widget is live and loads.", requires: ["1.5"], skippable: true },
        { key: "1.8", title: "Send the set-up email and welcome video", owner: CL, est: 5, done: "The email is approved and sent with the plan, report date, billing date, edit allowance and the hourly rate link.", requires: ["1.6"], say: "Your welcome email is on the way" },
        { key: "1.9", title: "Open the edit-hours ledger", owner: C, est: 1, done: "The ledger exists for the plan with its monthly allowance.", requires: ["1.2"] },
      ],
    },
  ]),
};

const CARE_1: SopTemplateInput = {
  key: "CARE-1",
  name: "Care weekly update",
  kind: "recurring",
  cadence: "weekly",
  cadenceDay: 3,
  appliesTo: ["care", "care_plus", "care_fallback"],
  active: true,
  steps: stepsOf([
    {
      key: "weekly", title: "Weekly update", steps: [
        { key: "1.1", title: "Pull the update list and sort it by risk", owner: C, est: 5, done: "Every update is sorted as security, major, mild or minor, and majors wait seven days unless they fix a security hole." },
        { key: "1.2", title: "Group the sites and pick test sites", owner: C, est: 2, done: "Sites are grouped by type and one or two in each group are chosen to go first.", requires: ["1.1"] },
        { key: "1.3", title: "Back up and update the test sites", owner: C, est: 10, done: "Backups are taken, the test sites are updated, and the visual, form, checkout and booking checks pass.", requires: ["1.2"] },
        { key: "1.4", title: "Approve the risky updates", owner: CL, est: 10, done: "Logan has approved or held every major or high-risk update (shop, builder, core, anything near checkout or forms).", requires: ["1.3"] },
        { key: "1.5", title: "Roll out to the rest in batches", owner: C, est: 20, done: "The queue is empty or each deferred update has a reason, a failed update was rolled back, and no health check is red.", requires: ["1.4"] },
        { key: "1.6", title: "Handle anything that broke", owner: L, est: 0, done: "A broken site or failed form has its own incident task, or nothing broke.", requires: ["1.3"], skippable: true },
      ],
    },
  ]),
};

const CARE_4: SopTemplateInput = {
  key: "CARE-4",
  name: "Care monthly report",
  kind: "recurring",
  cadence: "monthly",
  cadenceDay: 5,
  appliesTo: ["care", "care_plus", "care_fallback"],
  active: true,
  steps: stepsOf([
    {
      key: "monthly", title: "Monthly report", steps: [
        { key: "1.1", title: "Build each site's report", owner: C, est: 1, done: "Each report covers updates, backups, uptime, security, speed, traffic and search highlights, edits done, edit hours used and renewals coming up. A client with several sites gets one combined report." },
        { key: "1.2", title: "Write the summary and one recommendation", owner: CL, est: 3, done: "Each report opens with a plain summary and one suggestion, and Logan has approved it.", requires: ["1.1"] },
        { key: "1.3", title: "Send the reports", owner: CL, est: 1, done: "Every approved report is sent by the 7th with the intro and closing text.", requires: ["1.2"] },
        { key: "1.4", title: "Check billing", owner: C, est: 10, done: "Failed charges, cards about to expire, renewals in the next 60 days and term ends are listed.", requires: ["1.1"] },
        { key: "1.5", title: "Draft the payment reminders", owner: CL, est: 5, done: "A reminder is drafted for each failed payment, and Logan has approved or dropped it.", requires: ["1.4"] },
        { key: "1.6", title: "Refresh the client list", owner: C, est: 5, done: "Monthly income, churn, grade changes and upsell flags are updated, and no failed payment older than five days is without a follow-up.", requires: ["1.4"] },
      ],
    },
  ]),
};

export const SEED_SOPS: SopTemplateInput[] = [BUILD, QUICKFIX, CARE_0, CARE_1, CARE_4];
