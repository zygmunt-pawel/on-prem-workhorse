import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeText,
  hashText,
  mergeSlides,
  isNavLike,
  pickSlideCount,
  type CapturedSlide,
} from "./dynamic-reveal.js";

test("normalizeText collapses whitespace, trims, lowercases", () => {
  assert.equal(normalizeText("  Hello\n  World "), "hello world");
  assert.equal(normalizeText("A\t\tB"), "a b");
});

test("hashText is whitespace/case-insensitive and stable", () => {
  assert.equal(hashText("Proste  wydawanie"), hashText("proste wydawanie"));
  assert.equal(hashText(""), "");
  assert.equal(hashText("   "), "");
  assert.notEqual(hashText("slide one"), hashText("slide two"));
});

test("mergeSlides adds unique slides, dedups by normalized text, skips empty", () => {
  const collected = new Map<string, CapturedSlide>();
  const added1 = mergeSlides(collected, [
    { html: "<div>A</div>", text: "Slide A" },
    { html: "<div>A2</div>", text: "slide a" }, // dup of "Slide A"
    { html: "<div></div>", text: "   " }, // empty -> skipped
  ]);
  assert.equal(added1, 1);
  assert.equal(collected.size, 1);

  const added2 = mergeSlides(collected, [{ html: "<div>B</div>", text: "Slide B" }]);
  assert.equal(added2, 1);
  assert.equal(collected.size, 2);
});

test("isNavLike flags navigation/menu chrome only", () => {
  assert.equal(isNavLike("main-nav header__inner"), true);
  assert.equal(isNavLike("dropdown-menu show"), true);
  assert.equal(isNavLike("offcanvas-body"), true);
  assert.equal(isNavLike("hero-section how-it-works"), false);
  assert.equal(isNavLike("carousel-item active"), false);
});

test("pickSlideCount returns max candidate >= 2, else 0", () => {
  assert.equal(pickSlideCount([1, 4, 2]), 4);
  assert.equal(pickSlideCount([3]), 3);
  assert.equal(pickSlideCount([1, 1]), 0);
  assert.equal(pickSlideCount([]), 0);
  assert.equal(pickSlideCount([0, 1]), 0);
});
