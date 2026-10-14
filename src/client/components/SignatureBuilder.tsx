import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { MAX_SIGNATURE_LINKS, readSignature, writeSignature, type SignatureData } from "../emailView";

/** An email preview in a sandboxed frame: no scripts and no access to the app, whatever the HTML contains. */
export function EmailFrame({ html, title, height = 220 }: { html: string; title: string; height?: number }) {
  return <iframe className="email-frame" title={title} sandbox="" style={{ height }}
    srcDoc={`<!doctype html><meta charset="utf-8"><base target="_blank"><body style="margin:12px;background:#fff">${html}</body>`} />;
}

/**
 * Builds the signature that goes under every email. `value` is the saved JSON; edits are reported as JSON ("" when blank).
 * The preview is rendered by the server with the same code that builds the real email.
 */
export default function SignatureBuilder({ value, onChange }: { value: string; onChange: (json: string) => void }) {
  const [sig, setSig] = useState<SignatureData>(() => readSignature(value));
  const [preview, setPreview] = useState("");
  const tick = useRef(0);
  const json = writeSignature(sig);

  useEffect(() => {
    const mine = ++tick.current;
    const t = setTimeout(() => {
      api.post<{ html: string }>("/settings/signature-preview", { signature_json: json })
        .then((r) => { if (mine === tick.current) setPreview(r.html); })
        .catch(() => { if (mine === tick.current) setPreview(""); });
    }, 300);
    return () => clearTimeout(t);
  }, [json]);

  const edit = (patch: Partial<SignatureData>) => {
    const next = { ...sig, ...patch };
    setSig(next);
    onChange(writeSignature(next));
  };
  const setLink = (i: number, patch: Partial<SignatureData["links"][number]>) =>
    edit({ links: sig.links.map((l, n) => (n === i ? { ...l, ...patch } : l)) });
  const field = (id: string, label: string, key: "name" | "title" | "email" | "phone" | "website" | "image_url" | "image_link", placeholder = "") => (
    <div>
      <label htmlFor={`sig-${id}`}>{label}</label>
      <input id={`sig-${id}`} value={sig[key]} placeholder={placeholder} onChange={(e) => edit({ [key]: e.target.value })} />
    </div>
  );

  return (
    <div className="sig-builder">
      <div className="sig-grid">
        {field("name", "Name", "name")}
        {field("title", "Title", "title", "Front-end developer")}
        {field("email", "Email", "email")}
        {field("phone", "Phone", "phone")}
      </div>
      {field("website", "Website", "website", "yoursite.com")}

      <h4>Links</h4>
      {sig.links.map((l, i) => (
        <div className="sig-link" key={i}>
          <input aria-label={`Link ${i + 1} label`} placeholder="GitHub" value={l.label} onChange={(e) => setLink(i, { label: e.target.value })} />
          <input aria-label={`Link ${i + 1} address`} placeholder="https://github.com/you" value={l.url} onChange={(e) => setLink(i, { url: e.target.value })} />
          <button type="button" className="link-btn danger" onClick={() => edit({ links: sig.links.filter((_, n) => n !== i) })} aria-label={`Remove link ${i + 1}`}>Remove</button>
        </div>
      ))}
      {sig.links.length < MAX_SIGNATURE_LINKS && <p><button type="button" onClick={() => edit({ links: [...sig.links, { label: "", url: "" }] })}>Add a link</button></p>}

      <h4>Graphic</h4>
      <p className="muted small">A logo or headshot. It must be an https:// image address (PNG, JPG or GIF works in every email app; SVG does not).</p>
      {field("image", "Image address", "image_url", "https://yoursite.com/logo.png")}
      {sig.image_url.trim() && <>
        {field("image-link", "Where the image links to (optional)", "image_link", "https://yoursite.com")}
        <label htmlFor="sig-width">Image width: {sig.image_width}px</label>
        <input id="sig-width" type="range" min={40} max={300} step={4} value={sig.image_width} onChange={(e) => edit({ image_width: Number(e.target.value) })} />
      </>}

      <h4>Preview</h4>
      {json ? <EmailFrame html={preview} title="Signature preview" height={sig.image_url.trim() ? Math.max(150, sig.image_width + 60) : 150} />
        : <p className="muted small">Fill in a field above to see it. Until then the plain-text signature is used.</p>}
    </div>
  );
}
