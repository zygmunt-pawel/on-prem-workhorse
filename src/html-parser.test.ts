import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHtml } from "./html-parser.js";

const URL = "https://example.com";

test("responsive-hidden content (Tailwind 'hidden lg:flex') survives — visible on the desktop viewport", () => {
  const html = `<html><body><div class="hidden lg:flex"><p>DesktopVisibleContent</p></div></body></html>`;
  const { markdown } = parseHtml(html, URL);
  assert.ok(
    markdown.includes("DesktopVisibleContent"),
    "expected responsive-hidden content in markdown, got: " + JSON.stringify(markdown)
  );
});

test("responsive-hidden content with 'hidden md:block' also survives", () => {
  const html = `<html><body><div class="mt-2 hidden md:block"><p>MdBlockContent</p></div></body></html>`;
  const { markdown } = parseHtml(html, URL);
  assert.ok(markdown.includes("MdBlockContent"), "got: " + JSON.stringify(markdown));
});

test("truly hidden content (Tailwind 'hidden' with no responsive show) is removed", () => {
  const html = `<html><body><div class="hidden"><p>TrulyHiddenContent</p></div><p>ShownContent</p></body></html>`;
  const { markdown } = parseHtml(html, URL);
  assert.ok(!markdown.includes("TrulyHiddenContent"), "expected truly-hidden removed, got: " + JSON.stringify(markdown));
  assert.ok(markdown.includes("ShownContent"));
});

test("sr-only / visually-hidden content is still removed", () => {
  const html = `<html><body><div class="sr-only"><p>ScreenReaderOnly</p></div><p>VisibleText</p></body></html>`;
  const { markdown } = parseHtml(html, URL);
  assert.ok(!markdown.includes("ScreenReaderOnly"), "got: " + JSON.stringify(markdown));
  assert.ok(markdown.includes("VisibleText"));
});

test("inline display:none content is still removed", () => {
  const html = `<html><body><div style="display:none"><p>InlineHidden</p></div><p>InlineShown</p></body></html>`;
  const { markdown } = parseHtml(html, URL);
  assert.ok(!markdown.includes("InlineHidden"), "got: " + JSON.stringify(markdown));
  assert.ok(markdown.includes("InlineShown"));
});
