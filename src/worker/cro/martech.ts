export type MartechKind = "analytics" | "tag_manager" | "ad_pixel" | "call_tracking" | "chat" | "booking" | "ordering" | "cms" | "reviews";
export interface MartechRule { name: string; kind: MartechKind; host?: RegExp; script?: RegExp; global?: string }

export const MARTECH: MartechRule[] = [
  { name: "Google Analytics 4", kind: "analytics", host: /(^|\.)google-analytics\.com$/, global: "gtag" },
  { name: "Google Tag Manager", kind: "tag_manager", host: /(^|\.)googletagmanager\.com$/ },
  { name: "Microsoft Clarity", kind: "analytics", host: /(^|\.)clarity\.ms$/, global: "clarity" },
  { name: "Hotjar", kind: "analytics", host: /(^|\.)hotjar\.com$/, global: "hj" },
  { name: "Matomo", kind: "analytics", global: "_paq" },
  { name: "Plausible", kind: "analytics", host: /(^|\.)plausible\.io$/ },
  { name: "Meta Pixel", kind: "ad_pixel", host: /(^|\.)connect\.facebook\.net$/, global: "fbq" },
  { name: "Google Ads", kind: "ad_pixel", host: /(^|\.)(googleadservices\.com|doubleclick\.net)$/ },
  { name: "TikTok Pixel", kind: "ad_pixel", global: "ttq" },
  { name: "LinkedIn Insight", kind: "ad_pixel", host: /(^|\.)snap\.licdn\.com$/ },
  { name: "HubSpot", kind: "analytics", host: /(^|\.)(hs-scripts|hs-analytics|hubspot)\.(com|net)$/, global: "_hsq" },
  { name: "CallRail", kind: "call_tracking", host: /(^|\.)callrail\.com$/, global: "CallTrkSwap" },
  { name: "CallTrackingMetrics", kind: "call_tracking", host: /(^|\.)tctm\.co$|(^|\.)calltrackingmetrics\.com$/ },
  { name: "WhatConverts", kind: "call_tracking", host: /(^|\.)whatconverts\.com$/ },
  { name: "Intercom", kind: "chat", host: /(^|\.)intercom(cdn)?\.(io|com)$/, global: "Intercom" },
  { name: "Drift", kind: "chat", host: /(^|\.)drift\.com$/, global: "drift" },
  { name: "Tidio", kind: "chat", host: /(^|\.)tidio\.co$/, global: "tidioChatApi" },
  { name: "LiveChat", kind: "chat", global: "LiveChatWidget" },
  { name: "Tawk.to", kind: "chat", host: /(^|\.)tawk\.to$/, global: "Tawk_API" },
  { name: "Zendesk Chat", kind: "chat", global: "zE" },
  { name: "Podium", kind: "chat", host: /(^|\.)podium\.com$/ },
  { name: "Birdeye", kind: "reviews", host: /(^|\.)birdeye\.com$/ },
  { name: "Elfsight", kind: "reviews", host: /(^|\.)elfsight\.com$/ },
  { name: "Trustindex", kind: "reviews", host: /(^|\.)trustindex\.io$/ },
  { name: "Calendly", kind: "booking", host: /(^|\.)calendly\.com$/, global: "Calendly" },
  { name: "Vagaro", kind: "booking", host: /(^|\.)vagaro\.com$/ },
  { name: "Acuity", kind: "booking", host: /(^|\.)acuityscheduling\.com$/ },
  { name: "Mindbody", kind: "booking", host: /(^|\.)mindbody(online)?\.(com|io)$/ },
  { name: "Housecall Pro", kind: "booking", host: /(^|\.)housecallpro\.com$/ },
  { name: "ServiceTitan", kind: "booking", host: /(^|\.)servicetitan\.com$/ },
  { name: "Jobber", kind: "booking", host: /(^|\.)(getjobber|jobber)\.com$/ },
  { name: "OpenTable", kind: "booking", host: /(^|\.)opentable\.com$/ },
  { name: "Toast", kind: "ordering", host: /(^|\.)toasttab\.com$/ },
  { name: "Square", kind: "ordering", host: /(^|\.)(squareup\.com|square\.site|squarecdn\.com)$/ },
  { name: "Shopify", kind: "cms", host: /(^|\.)(cdn\.shopify\.com|myshopify\.com)$/, global: "Shopify" },
  { name: "Wix", kind: "cms", script: /wixstatic\.com|parastorage\.com/, global: "wixBiEvents" },
  { name: "Squarespace", kind: "cms", host: /(^|\.)(squarespace\.com|sqspcdn\.com)$/, global: "Squarespace" },
  { name: "WordPress", kind: "cms", script: /\/wp-content\/|\/wp-includes\// },
  { name: "Weebly", kind: "cms", script: /weebly\.com|editmysite\.com/ },
  { name: "GoDaddy Website Builder", kind: "cms", script: /img1\.wsimg\.com|godaddy/ },
  { name: "Webflow", kind: "cms", script: /webflow\.(com|io)/ },
];

export function detectMartech(i: { hosts: string[]; scripts: string[]; globals: string[] }): { name: string; kind: MartechKind }[] {
  const hosts = i.hosts.map((h) => h.toLowerCase());
  const globals = new Set(i.globals);
  return MARTECH.filter((r) => (r.host && hosts.some((h) => r.host!.test(h)))
    || (r.script && i.scripts.some((s) => r.script!.test(s)))
    || (r.global && globals.has(r.global))).map((r) => ({ name: r.name, kind: r.kind }));
}
