import {
  createRootRoute,
  HeadContent,
  Outlet,
  Scripts,
} from "@tanstack/react-router";
import appCss from "../styles.css?url";

const APP_NAME = "moshpit";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      {
        name: "viewport",
        content:
          "width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content",
      },
      { title: APP_NAME },
      {
        name: "description",
        content:
          "A little space for your whole herd. Follow your coding agents, answer what needs you, and keep working from any device.",
      },
      { name: "theme-color", content: "#222420" },
      { name: "apple-mobile-web-app-capable", content: "yes" },
    ],
    links: [
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
      { rel: "manifest", href: "/manifest.webmanifest" },
      { rel: "stylesheet", href: appCss },
    ],
  }),
  // No <html>/<head>/<body> here. That shape belongs to a server-rendered root;
  // this app is client-only and mounts into #root, which already sits inside the
  // real <body> — so rendering them again nested a second html/head/body inside
  // the first. Chromium tolerates it. Firefox wedges its main thread the moment
  // a focused text field takes a keystroke: one character froze the whole tab,
  // hard enough that no timer, error handler or pagehide beacon ever ran again.
  // React hoists the head tags from HeadContent on its own, so nothing is lost.
  component: () => (
    <>
      <HeadContent />
      <Outlet />
      <Scripts />
    </>
  ),
});
