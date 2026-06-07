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

test("class-based '.hidden' is NOT stripped by the parser (left to removeHiddenElements)", () => {
  // The browser-side removeHiddenElements drops genuine display:none using computed
  // styles at the real viewport. The parser must not strip by static class — that
  // wrongly removed responsive 'hidden lg:flex' content. So parseHtml alone keeps it.
  const html = `<html><body><div class="hidden"><p>ClassHiddenKeptByParser</p></div></body></html>`;
  const { markdown } = parseHtml(html, URL);
  assert.ok(
    markdown.includes("ClassHiddenKeptByParser"),
    "got: " + JSON.stringify(markdown)
  );
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

test("opacity:0 content with text survives (collapse/fade pattern, not treated as hidden)", () => {
  const html = `<html><body><div class="overflow-hidden" style="opacity:0; max-height:0px"><p>CollapsedFaqAnswer</p></div></body></html>`;
  const { markdown } = parseHtml(html, URL);
  assert.ok(
    markdown.includes("CollapsedFaqAnswer"),
    "expected opacity:0 collapsed content to survive, got: " + JSON.stringify(markdown)
  );
});
