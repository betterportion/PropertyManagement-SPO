import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Download, Loader2, Video, X } from "lucide-react";
import { MAX_REQUEST_VIDEOS, MAX_REQUEST_VIDEO_SECONDS, isVideoUpload } from "@shared/schema";

const MAX_VIDEO_MB = 30;
const ENDPOINT = "/api/maintenance-request-videos/upload";

/** How long a picked video runs, or null if this browser cannot read it (it still uploads). */
function videoSeconds(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    const url = URL.createObjectURL(file);
    const done = (value: number | null) => { URL.revokeObjectURL(url); resolve(value); };
    video.preload = "metadata";
    video.onloadedmetadata = () => done(Number.isFinite(video.duration) ? video.duration : null);
    video.onerror = () => done(null);
    video.src = url;
  });
}

/**
 * Up to three short videos on a request being filed (Joseph's notes, 2026-11-04):
 * .mov or .mp4, 20 seconds and 30 MB each, uploaded one at a time so a phone on
 * a slow connection is never sending three at once.
 */
export function RequestVideosField({ urls, onChange, onError }: {
  urls: { url: string; name: string }[];
  onChange: (urls: { url: string; name: string }[]) => void;
  onError: (message: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const upload = async (file: File) => {
    if (!/\.(mov|mp4)$/i.test(file.name)) return onError("Videos must be .mov or .mp4.");
    if (file.size > MAX_VIDEO_MB * 1024 * 1024) return onError(`Each video must be under ${MAX_VIDEO_MB} MB.`);
    const seconds = await videoSeconds(file);
    if (seconds !== null && seconds > MAX_REQUEST_VIDEO_SECONDS + 0.5) {
      return onError(`Each video can be up to ${MAX_REQUEST_VIDEO_SECONDS} seconds. This one is ${Math.round(seconds)}.`);
    }
    setUploading(true);
    try {
      const body = new FormData();
      body.append("file", file);
      const response = await fetch(ENDPOINT, { method: "POST", body, credentials: "include" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) return onError(data.message ?? "The video could not be uploaded. Try again.");
      onError("");
      onChange([...urls, { url: data.url, name: file.name }]);
    } catch {
      onError("The video could not be uploaded. Check your connection and try again.");
    } finally {
      setUploading(false);
      if (input.current) input.current.value = "";
    }
  };

  return (
    <div className="space-y-2">
      {urls.length > 0 && (
        <ul className="space-y-1" data-testid="request-video-list">
          {urls.map(({ url, name }) => (
            <li key={url} className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
              <Video className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{name}</span>
              <Button type="button" size="icon" variant="ghost" className="h-6 w-6" aria-label={`Remove ${name}`}
                onClick={() => onChange(urls.filter((u) => u.url !== url))}>
                <X className="h-4 w-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {urls.length < MAX_REQUEST_VIDEOS && (
        <>
          <input ref={input} type="file" accept="video/mp4,video/quicktime,.mov,.mp4" className="hidden"
            data-testid="input-video-upload" onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
          <Button type="button" variant="secondary" disabled={uploading} onClick={() => input.current?.click()} data-testid="button-add-video">
            {uploading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Video className="mr-2 h-4 w-4" />}
            {uploading ? "Uploading video..." : "Add a video"}
          </Button>
        </>
      )}
    </div>
  );
}

/**
 * A request photo or video. A video plays where the browser can, and always
 * offers a download, since some browsers cannot play a phone's .mov.
 */
export function RequestMedia({ url, alt, className }: { url: string; alt: string; className?: string }) {
  if (!isVideoUpload(url)) return <img src={url} alt={alt} loading="lazy" className={className} />;
  return (
    <div className="relative h-full w-full">
      <video src={url} controls preload="metadata" playsInline className={className} aria-label={alt} />
      <a href={url} download className="absolute right-1 top-1 rounded bg-background/90 p-1 text-foreground shadow-sm" aria-label="Download video" data-testid="link-download-video">
        <Download className="h-3.5 w-3.5" />
      </a>
    </div>
  );
}
