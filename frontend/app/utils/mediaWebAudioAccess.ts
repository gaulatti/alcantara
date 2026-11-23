/**
 * Whether Web Audio may take over this media element's output.
 *
 * A MediaElementAudioSourceNode on a cross-origin source loaded without CORS
 * outputs silence (Web Audio specification: "outputs zeroes due to CORS access
 * restrictions"). The level meters route such an element through Web Audio and
 * mute the element itself, so routing a source Web Audio cannot read silences
 * it. Engines without `captureStream()` on media elements (WebKit, so Safari
 * and the desktop console) always reach that routing.
 *
 * An element with `crossOrigin` set is loaded in CORS mode: it either plays
 * readable samples or fails to load, never plays tainted. Same-origin, blob:
 * and data: sources are readable.
 */
export function canRouteMediaThroughWebAudio(
  media: HTMLMediaElement,
  pageHref: string = window.location.href,
): boolean {
  if (typeof media.crossOrigin === "string") {
    return true;
  }
  const source = media.currentSrc || media.src;
  if (!source) {
    return false;
  }
  let url: URL;
  let page: URL;
  try {
    url = new URL(source, pageHref);
    page = new URL(pageHref);
  } catch {
    return false;
  }
  if (url.protocol === "blob:" || url.protocol === "data:") {
    return true;
  }
  return url.origin === page.origin;
}
