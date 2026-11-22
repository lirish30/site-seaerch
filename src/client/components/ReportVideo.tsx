/** The short silent video of a client's monthly report, when one was made. `src` is the report's own relative route (`/api/public/m/<token>/video.mp4` or `.../l/...`), so the file's key is never on the page. */
export default function ReportVideo({ src }: { src: string }) {
  return (
    <figure className="mr-video">
      <video controls preload="metadata" playsInline src={src} />
      <figcaption className="mr-note">A 40 second summary</figcaption>
    </figure>
  );
}
