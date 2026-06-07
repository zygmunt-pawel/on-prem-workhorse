import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeText,
  hashText,
  mergeSlides,
  isNavLike,
  pickSlideCount,
  isFaqToggle,
  parseFaqJsonLd,
  type CapturedSlide,
  type FaqToggleSignals,
} from "./dynamic-reveal.js";

/** Minimal valid signals; override per case. */
function sig(overrides: Partial<FaqToggleSignals>): FaqToggleSignals {
  return {
    tag: "BUTTON",
    roleButton: false,
    isLink: false,
    text: "Question?",
    ariaExpanded: null,
    hasChevronIcon: false,
    ...overrides,
  };
}

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

test("isFaqToggle: aria-expanded='false' on a button is a collapsed accordion", () => {
  assert.equal(isFaqToggle(sig({ ariaExpanded: "false", text: "Anything" })), true);
});

test("isFaqToggle: aria-expanded='true' is already open -> skip", () => {
  assert.equal(isFaqToggle(sig({ ariaExpanded: "true" })), false);
});

test("isFaqToggle: links are never clicked (avoid navigation)", () => {
  assert.equal(
    isFaqToggle(sig({ tag: "A", isLink: true, hasChevronIcon: true, text: "Pricing?" })),
    false
  );
});

test("isFaqToggle: button + chevron + question text (headless Tailwind/Framer accordion)", () => {
  assert.equal(
    isFaqToggle(
      sig({ hasChevronIcon: true, text: "How realistic are the AI conversations?" })
    ),
    true
  );
});

test("isFaqToggle: button + chevron + short non-question label (e.g. 'Pricing')", () => {
  assert.equal(isFaqToggle(sig({ hasChevronIcon: true, text: "Shipping and returns" })), true);
});

test("isFaqToggle: chevron but long non-question text is not a toggle", () => {
  const longLabel =
    "this is a fairly long button label that is clearly not a question and has many words";
  assert.equal(isFaqToggle(sig({ hasChevronIcon: true, text: longLabel })), false);
});

test("isFaqToggle: plain button without chevron/aria is not a toggle", () => {
  assert.equal(isFaqToggle(sig({ text: "Submit" })), false);
});

test("isFaqToggle: non-clickable element (div, no role/aria) is never a toggle", () => {
  assert.equal(
    isFaqToggle(sig({ tag: "DIV", hasChevronIcon: true, text: "Is this a question?" })),
    false
  );
});

test("isFaqToggle: blank text is not a toggle", () => {
  assert.equal(isFaqToggle(sig({ ariaExpanded: "false", text: "   " })), false);
});

test("parseFaqJsonLd extracts Q&A from a standard FAQPage with mainEntity array", () => {
  const json = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: [
      {
        "@type": "Question",
        name: "How fast is it?",
        acceptedAnswer: { "@type": "Answer", text: "About 30 seconds." },
      },
      {
        "@type": "Question",
        name: "Do I need keywords?",
        acceptedAnswer: { "@type": "Answer", text: "No, it's automatic." },
      },
    ],
  });
  assert.deepEqual(parseFaqJsonLd(json), [
    { question: "How fast is it?", answer: "About 30 seconds." },
    { question: "Do I need keywords?", answer: "No, it's automatic." },
  ]);
});

test("parseFaqJsonLd strips HTML tags and decodes entities in answers", () => {
  const json = JSON.stringify({
    "@type": "FAQPage",
    mainEntity: {
      "@type": "Question",
      name: "Tags &amp; markup?",
      acceptedAnswer: { text: "Use <strong>keywords</strong> &amp; tags." },
    },
  });
  assert.deepEqual(parseFaqJsonLd(json), [
    { question: "Tags & markup?", answer: "Use keywords & tags." },
  ]);
});

test("parseFaqJsonLd finds FAQPage inside an @graph wrapper", () => {
  const json = JSON.stringify({
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "Organization", name: "Acme" },
      {
        "@type": "FAQPage",
        mainEntity: [
          { "@type": "Question", name: "Q?", acceptedAnswer: { text: "A." } },
        ],
      },
    ],
  });
  assert.deepEqual(parseFaqJsonLd(json), [{ question: "Q?", answer: "A." }]);
});

test("parseFaqJsonLd returns [] for invalid JSON", () => {
  assert.deepEqual(parseFaqJsonLd("{ not json"), []);
});

test("parseFaqJsonLd returns [] when no FAQPage present", () => {
  const json = JSON.stringify({ "@type": "Organization", name: "Acme" });
  assert.deepEqual(parseFaqJsonLd(json), []);
});

test("parseFaqJsonLd skips questions with empty name or answer", () => {
  const json = JSON.stringify({
    "@type": "FAQPage",
    mainEntity: [
      { "@type": "Question", name: "  ", acceptedAnswer: { text: "orphan" } },
      { "@type": "Question", name: "Real?", acceptedAnswer: { text: "" } },
      { "@type": "Question", name: "Good?", acceptedAnswer: { text: "Yes." } },
    ],
  });
  assert.deepEqual(parseFaqJsonLd(json), [{ question: "Good?", answer: "Yes." }]);
});
