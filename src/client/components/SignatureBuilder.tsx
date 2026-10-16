import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { MAX_SIGNATURE_LINKS, readSignature, writeSignature, type SignatureData } from "../emailView";
import { isHttps, safeLink } from "../settingsPagesView";
import Icon from "./Icon";
import { Card, Field, Row } from "./SettingsPage";

/**
 * An email preview in a sandboxed frame: no scripts and no access to the app, whatever the HTML contains.
 * With `fit` the frame grows to its content (it may read its own document, which is safe because scripts stay off).
 */
export function EmailFrame({ html, title, height = 220, fit }: { html: string; title: string; height?: number; fit?: boolean }) {
  const [h, setH] = useState(fit ? 80 : height);
  const style = fit ? "margin:0;background:#fff;font:13px/1.4 Arial,Helvetica,sans-serif;color:#222" : "margin:12px;background:#fff";
  return <iframe className="email-frame" title={title} sandbox={fit ? "allow-same-origin" : ""} style={{ height: fit ? h : height }}
    onLoad={fit ? (e) => { const d = e.currentTarget.contentDocument; if (d) setH(Math.max(40, Math.ceil(d.body.getBoundingClientRect().height))); } : undefined}
    srcDoc={`<!doctype html><meta charset="utf-8"><base target="_blank">${fit ? "<style>body>table:first-child{margin-top:0!important}</style>" : ""}<body style="${style}">${html}</body>`} />;
}

type TextKey = "name" | "title" | "email" | "phone" | "website" | "image_url" | "image_link";

/**
 * Builds the signature that goes under every email, as three cards (details, links, graphic) beside a live preview.
 * `value` is the saved JSON; edits are reported as JSON ("" when blank). The preview is rendered by the server with the same
 * code that builds the real email. Addresses the server would refuse are flagged here before saving.
 */
export default function SignatureBuilder({ value, onChange }: { value: string; onChange: (json: string) => void }) {
  const [sig, setSig] = useState<SignatureData>(() => readSignature(value));
  const [preview, setPreview] = useState("");
  const tick = useRef(0);
  const json = writeSignature(sig);

  // Discard (or a save that normalised the links) changes `value` from outside: take it back in.
  useEffect(() => { if (value !== json) setSig(readSignature(value)); }, [value]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!json) { setPreview(""); return; }
    const mine = ++tick.current;
    const t = setTimeout(() => {
      api.post<{ html: string }>("/settings/signature-preview", { signature_json: json })
        .then((r) => { if (mine === tick.current) setPreview(r.html); })
        .catch(() => { if (mine === tick.current) setPreview(""); });
    }, 300);
    return () => clearTimeout(t);
  }, [json]);

  const edit = (patch: Partial<SignatureData>) => { const next = { ...sig, ...patch }; setSig(next); onChange(writeSignature(next)); };
  const setLink = (i: number, patch: Partial<SignatureData["links"][number]>) => edit({ links: sig.links.map((l, n) => (n === i ? { ...l, ...patch } : l)) });
  const badUrl = (u: string) => u.trim() !== "" && safeLink(u) === "";
  const text = (id: TextKey, label: string, placeholder = "", error?: string, help?: string) => (
    <Field label={label} htmlFor={`sig-${id}`} error={error} help={help}>
      <input id={`sig-${id}`} value={sig[id]} placeholder={placeholder} onChange={(e) => edit({ [id]: e.target.value })} />
    </Field>
  );
  const hasImage = sig.image_url.trim() !== "";
  const imageBad = hasImage && !isHttps(sig.image_url);
  const pct = (sig.image_width - 40) / 260;

  return (
    <div className="sg-layout">
      <div className="sg-form">
        <Card title="Details">
          <Row>{text("name", "Name")}{text("title", "Title", "Front-end developer")}</Row>
          <Row>{text("email", "Email")}{text("phone", "Phone")}</Row>
          {text("website", "Website", "yoursite.com", badUrl(sig.website) ? "That isn't a web address. Use something like yoursite.com." : undefined)}
        </Card>
        <Card title="Links" sub={`Up to ${MAX_SIGNATURE_LINKS}. Shown as small text links.`}>
          {sig.links.map((l, i) => (
            <div key={i} style={{ display: "contents" }}>
              <div className="sg-link">
                <input className="st-input" aria-label={`Link ${i + 1} label`} placeholder="GitHub" maxLength={60} value={l.label} onChange={(e) => setLink(i, { label: e.target.value })} />
                <input className="st-input url" aria-label={`Link ${i + 1} address`} placeholder="https://github.com/you" aria-invalid={badUrl(l.url)} value={l.url} onChange={(e) => setLink(i, { url: e.target.value })} />
                <button type="button" className="sg-x" aria-label={`Remove link ${i + 1}`} onClick={() => edit({ links: sig.links.filter((_, n) => n !== i) })}><Icon name="x" size={14} /></button>
              </div>
              {badUrl(l.url) && <p className="sg-link-err" role="alert">Link {i + 1} isn't a web address. Links need http(s):// or a domain like github.com/you.</p>}
            </div>
          ))}
          <button type="button" className="btn-ghost-sm sg-add" disabled={sig.links.length >= MAX_SIGNATURE_LINKS} onClick={() => edit({ links: [...sig.links, { label: "", url: "" }] })}>
            <Icon name="plus" size={16} />Add a link
          </button>
        </Card>
        <Card title="Graphic" sub="Optional. A small logo or headshot.">
          {text("image_url", "Image address", "https://yoursite.com/logo.png", imageBad ? "The image must be an https:// address (PNG, JPG or GIF; SVG doesn't show in every email app)." : undefined)}
          {hasImage && <>
            <div className="sg-width">
              <div className="top"><label htmlFor="sig-width">Image width</label><output htmlFor="sig-width">{sig.image_width} px</output></div>
              <input id="sig-width" className="sg-range" type="range" min={40} max={300} step={4} value={sig.image_width} style={{ ["--p" as string]: pct }} onChange={(e) => edit({ image_width: Number(e.target.value) })} />
            </div>
            {text("image_link", "Where the image links to (optional)", "https://yoursite.com", badUrl(sig.image_link) ? "That isn't a web address." : undefined)}
          </>}
        </Card>
      </div>
      <aside className="sg-preview" aria-label="Signature preview">
        <h3>Preview</h3>
        <div className="sg-mail">
          <p className="lead">…happy to send the full write-up of your site.</p>
          {json && preview ? <EmailFrame fit html={preview} title="Signature preview" /> : <p className="empty">{json ? "Building the preview…" : "Fill in a field to see your signature here. Until then the plain-text signature is used."}</p>}
        </div>
        <p className="sg-note"><Icon name="info" size={13} />This is how it looks in the Gmail draft.</p>
      </aside>
    </div>
  );
}
