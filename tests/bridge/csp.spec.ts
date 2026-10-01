import { test, expect } from "../fixtures";

const ONE = "https://one.example.test";
const TWO = "https://two.example.test";
const THREE = "https://three.example.test";

// The CSP is the bridge's, so this drives the app as the bridge serves it,
// not vite preview. Two bridges are listed; a third is not.
test("the bridge-served app loads cleanly, reaches listed bridges, and explains an unlisted one", async ({ page, bridge }) => {
  const host = await bridge({ env: { MOSHPIT_CONNECT_ORIGINS: `${ONE},${TWO}` } });
  await page.addInitScript(() => {
    (window as unknown as { violations: string[] }).violations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      (window as unknown as { violations: string[] }).violations.push(`${event.effectiveDirective} ${event.blockedURI}`);
    });
  });
  for (const origin of [ONE, TWO, THREE]) {
    await page.route(`${origin}/**`, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ protocol: 2, requiredFactors: [] }) }),
    );
  }

  // The demo herd renders Markdown, the fonts and the service worker, all
  // from this origin.
  await page.goto(`${host.url}/?demo=1`, { waitUntil: "networkidle" });
  for (let step = 0; step < 2; step += 1) await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByRole("button", { name: "Open moshpit" }).click();
  await page.getByRole("navigation", { name: "Primary" }).waitFor();
  const loaded = await page.evaluate(async () => {
    await document.fonts.ready;
    return {
      fonts: document.fonts.check("16px 'IBM Plex Sans'"),
      worker: Boolean(await Promise.race([navigator.serviceWorker.ready, new Promise((resolve) => setTimeout(() => resolve(null), 5000))])),
      violations: (window as unknown as { violations: string[] }).violations,
    };
  });
  expect(loaded.violations).toEqual([]);
  expect(loaded.fonts).toBe(true);
  expect(loaded.worker).toBe(true);

  const reach = await page.evaluate(async (origins) => {
    const out: Record<string, string> = {};
    for (const origin of origins) {
      out[origin] = await fetch(`${origin}/api/auth-info`).then((r) => `ok ${r.status}`, () => "blocked");
    }
    // The violation event is dispatched after the fetch has already rejected.
    const seen = () => (window as unknown as { violations: string[] }).violations;
    for (let i = 0; i < 50 && !seen().length; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    return { out, violations: seen() };
  }, [ONE, TWO, THREE]);
  expect(reach.out).toEqual({ [ONE]: "ok 200", [TWO]: "ok 200", [THREE]: "blocked" });
  expect(reach.violations).toEqual([`connect-src ${THREE}/api/auth-info`]);

  // Hosts says what the operator has to change instead of a bare failure.
  await page.getByRole("button", { name: /hosts/i }).first().click();
  await page.getByRole("button", { name: "Add host" }).click();
  await page.getByLabel("Bridge URL").fill(THREE);
  await page.getByRole("button", { name: "Save host" }).click();
  await expect(page.getByText(/Add https:\/\/three\.example\.test to MOSHPIT_CONNECT_ORIGINS/)).toBeVisible();
});
