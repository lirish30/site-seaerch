/** Runs inside the page and returns a PageSnapshot. Kept as a string: bundler helpers would break a serialized function. */
export const PROBE_SCRIPT = String.raw`(() => {
  const vw = window.innerWidth, vh = window.innerHeight;
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
  const box = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) }; };
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0; };
  const header = document.querySelector("header, [role=banner], #header, .header, .site-header");
  const inHeader = (el) => header ? header.contains(el) : box(el).y < 120;
  const rgb = (c) => { const m = (c || "").match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(",").map((x) => parseFloat(x)); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const lum = (c) => { const f = (v) => { v = v / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const bgOf = (el) => { for (let e = el; e; e = e.parentElement) { const s = getComputedStyle(e); const c = rgb(s.backgroundColor); if (c && c.a > 0.5) return c; if (s.backgroundImage && s.backgroundImage !== "none") return null; } return { r: 255, g: 255, b: 255, a: 1 }; };
  const contrast = (el) => { const fg = rgb(getComputedStyle(el).color); const bg = bgOf(el); if (!fg || !bg) return null; const a = lum(fg), b = lum(bg); const hi = Math.max(a, b), lo = Math.min(a, b); return Math.round(((hi + 0.05) / (lo + 0.05)) * 10) / 10; };

  const ACTION = /book|schedule|appointment|quote|estimate|call|contact|order|reserve|buy|shop|get started|sign up|enroll|request|free|consult|apply|donate|join/i;
  const ctaEls = [...document.querySelectorAll("a, button, [role=button], input[type=submit]")].filter(visible).filter((el) => {
    const t = clean(el.innerText || el.value);
    if (!t || t.length > 40) return false;
    const s = getComputedStyle(el); const bg = rgb(s.backgroundColor);
    const looksButton = el.tagName !== "A" || (bg && bg.a > 0.5) || /btn|button|cta/i.test(String(el.className)) || (parseFloat(s.borderWidth) > 0 && s.borderStyle !== "none");
    return looksButton && (ACTION.test(t) || el.tagName !== "A");
  }).slice(0, 40);
  const ctas = ctaEls.map((el) => { const b = box(el); return { text: clean(el.innerText || el.value), href: el.getAttribute("href"), box: b, aboveFold: b.y < vh, inHeader: inHeader(el), contrast: contrast(el), fontPx: parseFloat(getComputedStyle(el).fontSize) }; });

  const navRoot = document.querySelector("header nav, nav, [role=navigation]");
  const navTree = (ul, depth) => [...ul.children].filter((li) => li.tagName === "LI").map((li) => {
    const a = li.querySelector(":scope > a, :scope > span, :scope > button");
    const sub = li.querySelector(":scope > ul, :scope > div ul");
    return { text: clean(a ? a.textContent : (li.firstChild ? li.firstChild.textContent : "")), href: a ? a.getAttribute("href") : null, children: sub && depth < 2 ? navTree(sub, depth + 1) : [] };
  }).filter((n) => n.text);
  let nav = [];
  if (navRoot) { const ul = navRoot.querySelector("ul"); nav = ul ? navTree(ul, 0) : [...navRoot.querySelectorAll("a")].slice(0, 30).map((a) => ({ text: clean(a.textContent), href: a.getAttribute("href"), children: [] })).filter((n) => n.text); }
  const fixedLike = (e) => { const p = getComputedStyle(e).position; return p === "fixed" || p === "sticky"; };
  const stickyHeader = (header && fixedLike(header)) || [...document.querySelectorAll("body > *, body > * > *")].slice(0, 200).some((e) => { const r = e.getBoundingClientRect(); return fixedLike(e) && r.top <= 0 && r.width >= vw * 0.9 && r.height < vh * 0.3; });

  const telLinks = [...document.querySelectorAll('a[href^="tel:"]')].filter(visible).map((a) => ({ text: clean(a.textContent), href: a.getAttribute("href"), inHeader: inHeader(a), box: box(a) }));
  const PHONE = /(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/;
  const hm = header ? clean(header.innerText).match(PHONE) : null;
  const headerPhoneText = hm ? hm[0] : null;
  const mailtoCount = document.querySelectorAll('a[href^="mailto:"]').length;

  const labelFor = (inp) => {
    if (inp.id) { const l = document.querySelector('label[for="' + CSS.escape(inp.id) + '"]'); if (l) return clean(l.textContent); }
    const wrap = inp.closest("label"); if (wrap) return clean(wrap.textContent);
    return clean(inp.getAttribute("aria-label") || inp.getAttribute("placeholder") || inp.name);
  };
  const forms = [...document.querySelectorAll("form")].filter(visible).map((f) => {
    const fields = [...f.querySelectorAll("input, select, textarea")].filter((i) => !["hidden", "submit", "button", "image", "reset"].includes((i.type || "").toLowerCase()) && visible(i))
      .map((i) => ({ label: labelFor(i).slice(0, 80), name: i.name || "", type: (i.type || i.tagName).toLowerCase(), required: !!i.required || i.getAttribute("aria-required") === "true" }));
    const submit = f.querySelector("button[type=submit], input[type=submit], button:not([type])");
    return { fields, hasCaptcha: !!f.querySelector('.g-recaptcha, [data-sitekey], iframe[src*="recaptcha"], iframe[src*="hcaptcha"], .cf-turnstile'),
      privacyNote: /privacy|never share|no spam/i.test(f.innerText), submitText: clean(submit ? (submit.innerText || submit.value) : ""), box: box(f) };
  }).filter((f) => f.fields.length > 0 && !(f.fields.length === 1 && f.fields[0].type === "search"));

  const bodyText = clean(document.body ? document.body.innerText : "");
  const html = document.documentElement.innerHTML;
  const WIDGETS = [["Google reviews widget", /elfsight|trustindex|reviewsonmywebsite|embedsocial|birdeye|nicejob|grade\.us/i], ["Trustpilot widget", /widget\.trustpilot|trustpilot\.com\/review/i], ["Yelp badge", /yelp\.com\/biz/i]];
  const w = WIDGETS.find((x) => x[1].test(html));
  const testis = [...document.querySelectorAll('[class*="testimonial" i], blockquote')].filter(visible);
  const attributed = testis.filter((t) => /<cite|class="[^"]*(author|name)/i.test(t.innerHTML) || /[—–-]\s*[A-Z][a-z]+/.test(t.innerText)).length;
  const badgeCount = [...document.querySelectorAll("img")].filter((i) => /bbb|licensed|insured|certified|award|accredit|association|angi|homeadvisor|best of/i.test((i.alt || "") + " " + (i.src || ""))).length;
  const gm = bodyText.match(/[^.]*\b(guarantee[d]?|warranty|money[- ]back|satisfaction)\b[^.]*\./i);
  const ym = bodyText.match(/\b(since (19|20)\d{2}|\d{1,3}\+? years( of experience| in business)?)\b/i);

  const GLOBALS = ["gtag", "dataLayer", "fbq", "_hsq", "ttq", "clarity", "hj", "Intercom", "drift", "tidioChatApi", "LiveChatWidget", "Calendly", "_paq", "Shopify", "wixBiEvents", "Squarespace", "Tawk_API", "zE", "CallTrkSwap"];
  let total = 0, small = 0;
  for (const el of document.querySelectorAll("p, li, a, span, td, label, button")) {
    const t = (el.textContent || "").trim();
    if (!t || el.children.length > 0 || !visible(el)) continue;
    total += t.length;
    if (parseFloat(getComputedStyle(el).fontSize) < 12) small += t.length;
  }
  const h1 = [...document.querySelectorAll("h1")].filter(visible).map((h) => clean(h.innerText)).filter(Boolean).slice(0, 3);
  const heroText = clean([...document.querySelectorAll("h1, h2, p")].filter((e) => visible(e) && box(e).y < vh).map((e) => e.innerText).join(" ")).slice(0, 600);
  return {
    url: location.href, title: document.title, viewport: { w: vw, h: vh }, h1, heroText, ctas, nav, stickyHeader: !!stickyHeader,
    telLinks, headerPhoneText, mailtoCount, forms,
    trust: { reviewWidget: w ? w[0] : null, testimonialCount: testis.length, attributedTestimonials: attributed, badgeCount, guaranteeText: gm ? clean(gm[0]).slice(0, 200) : null, yearsText: ym ? ym[0] : null },
    scripts: [...document.scripts].map((s) => s.src).filter(Boolean).slice(0, 80),
    globals: GLOBALS.filter((g) => typeof window[g] !== "undefined"),
    overflowX: document.documentElement.scrollWidth > vw + 4, smallTextPct: total ? small / total : 0,
    text: bodyText.slice(0, 50000),
  };
})()`;

/** On the page the main button leads to: visible form fields and embedded iframes (booking widgets). */
export const FLOW_PROBE = String.raw`(() => {
  const vis = (i) => i.offsetParent !== null;
  const fields = [...document.querySelectorAll("input, select, textarea")].filter((i) => !["hidden", "submit", "button"].includes((i.type || "").toLowerCase()) && vis(i)).length;
  const iframes = [...document.querySelectorAll("iframe")].map((f) => f.src).filter(Boolean);
  return { fields, iframes };
})()`;

/** Needs axe-core injected first. Counts serious problems only; minor ones aren't worth a business owner's attention. */
export const AXE_RUN = String.raw`(async () => {
  const r = await axe.run(document, { resultTypes: ["violations"] });
  const bad = r.violations.filter((x) => x.impact === "critical" || x.impact === "serious");
  return { critical: bad.filter((x) => x.impact === "critical").length, serious: bad.filter((x) => x.impact === "serious").length,
    top: bad.slice(0, 8).map((x) => ({ id: x.id, help: x.help, nodes: x.nodes.length })) };
})()`;
