#!/usr/bin/env node
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const port = Number(process.argv[2] ?? 8193);
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await page.goto(`http://127.0.0.1:${port}/?demo=1`);
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('button', { name: 'Open moshpit' }).click();
  await page.getByText('migrate', { exact: true }).click();
  await page.getByRole('button', { name: 'Terminal view' }).click();
  const pane = page.getByRole('application', { name: /^Pane / });
  await pane.focus();
  const input = page.getByRole('textbox', { name: 'Terminal input' });
  await input.fill('/model');
  assert.equal(await input.inputValue(), '/model');
  console.log('PASS composer holds /model separately from pane input');
  await pane.focus();
  const button = page.getByRole('button', { name: 'Backspace', exact: true });
  assert.equal(await button.innerText(), '⌫');
  assert.equal(await button.count(), 1, 'phone key bar needs a Backspace button for text already in the pane');
  await button.click();
  await page.getByText('backspace', { exact: true }).waitFor();
  assert.equal(await input.inputValue(), '/model', 'pane Backspace must not edit the composer draft');
  console.log('PASS on-screen Backspace reaches pane without editing composer draft');
} finally {
  await browser.close();
}
