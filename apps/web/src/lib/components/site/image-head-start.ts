import { imageUrlCandidates, publishedContentGateway } from "./image-fallback.js";

/**
 * How long a published page's first image address gets before the second is asked
 * too. Measured 2026-11-24: our gateway answers an event image in 0.1-0.3 s and
 * Etherna's in 1.0-1.3 s, so a first answer still missing at 0.6 s is the slow
 * case a second request is for - and in every other case there is only one.
 */
export const IMAGE_HEAD_START_MS = 600;

export interface ImageHeadStartParams {
  imageHash?: string;
  preferredGateway?: string;
  storedOn?: string;
}

/**
 * The two addresses a head start may use, or null: only on a published page (our
 * gateway first, the stored-on gateway second - `imageUrlCandidates`), and only when
 * there is a second. Elsewhere the app keeps its order with no second request: there
 * the first is Etherna, which our bee's chequebook does not pay for.
 */
export function headStartPair(params: ImageHeadStartParams): { first: string; second: string } | null {
  if (!publishedContentGateway()) return null;
  const [first, second] = imageUrlCandidates(params.imageHash, params.preferredGateway, params.storedOn);
  return first && second ? { first, second } : null;
}

/**
 * Svelte action for an <img> whose `src` is the first candidate and whose onerror
 * moves to the next (`useNextImageUrl`). If the first has not loaded `delayMs` after
 * the image starts loading (for a lazy image: once it nears the viewport), the
 * second is fetched beside it and shown if it arrives first; whichever wins, the
 * other is dropped. A failure still moves on through onerror as before.
 */
export function imageHeadStart(node: HTMLImageElement, params: ImageHeadStartParams) {
  let stop = arm(node, params, IMAGE_HEAD_START_MS);
  return {
    update(next: ImageHeadStartParams) {
      stop();
      stop = arm(node, next, IMAGE_HEAD_START_MS);
    },
    destroy() {
      stop();
    },
  };
}

function arm(node: HTMLImageElement, params: ImageHeadStartParams, delayMs: number): () => void {
  const pair = headStartPair(params);
  if (!pair) return () => {};

  let timer: ReturnType<typeof setTimeout> | undefined;
  let observer: IntersectionObserver | undefined;
  let backup: HTMLImageElement | null = null;
  const loaded = () => node.complete && node.naturalWidth > 0;
  const stillFirst = () => node.getAttribute("src") === pair.first;

  const settle = () => {
    clearTimeout(timer);
    observer?.disconnect();
    if (backup) {
      backup.onload = null;
      backup.removeAttribute("src");
      backup = null;
    }
  };

  const startTimer = () => {
    timer = setTimeout(() => {
      if (loaded() || !stillFirst()) return;
      const b = new Image();
      backup = b;
      b.onload = () => {
        if (backup !== b) return;
        backup = null;
        if (loaded() || !stillFirst()) return;
        node.dataset.imageGatewayIndex = "1";
        node.setAttribute("src", pair.second);
      };
      b.src = pair.second;
    }, delayMs);
  };

  node.addEventListener("load", settle);
  node.addEventListener("error", settle);
  if (loaded()) {
    settle();
  } else if (node.loading === "lazy" && typeof IntersectionObserver !== "undefined") {
    observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        observer?.disconnect();
        startTimer();
      },
      { rootMargin: "200px" },
    );
    observer.observe(node);
  } else {
    startTimer();
  }

  return () => {
    settle();
    node.removeEventListener("load", settle);
    node.removeEventListener("error", settle);
  };
}
