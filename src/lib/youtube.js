const SCRIPT_SELECTOR = "script[data-youtube-iframe]";

export function loadYouTubeIframeApi(doc = document, win = window) {
  if (win.YT?.Player) return Promise.resolve(win.YT);
  if (win.__karaokeYouTubeIframePromise) return win.__karaokeYouTubeIframePromise;

  win.__karaokeYouTubeIframePromise = new Promise((resolve) => {
    const previousReady = win.onYouTubeIframeAPIReady;
    win.onYouTubeIframeAPIReady = () => {
      previousReady?.();
      resolve(win.YT);
    };
    if (!doc.querySelector(SCRIPT_SELECTOR)) {
      const script = doc.createElement("script");
      script.src = "https://www.youtube.com/iframe_api";
      script.dataset.youtubeIframe = "true";
      script.async = true;
      doc.head.append(script);
    }
  });
  return win.__karaokeYouTubeIframePromise;
}
