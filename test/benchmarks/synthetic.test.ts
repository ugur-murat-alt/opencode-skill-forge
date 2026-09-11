import { test, expect } from "bun:test";
import {
  computeSyntheticMetadata,
  createRng,
  generateSyntheticDataset,
  syntheticCorpusHash,
} from "../fixtures/memory-benchmark/synthetic.js";

test("createRng is reproducible and bounded", () => {
  const a = createRng(7);
  const b = createRng(7);
  for (let i = 0; i < 1000; i++) {
    const value = a();
    expect(value).toBe(b());
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThan(1);
  }
  expect(createRng(7)()).toBe(createRng(7)());
  expect(createRng(8)()).not.toBe(createRng(7)());
});

test("synthetic corpus is byte-deterministic for a seed and changes with the seed", () => {
  const first = generateSyntheticDataset({ seed: 2026, size: 1000 });
  const second = generateSyntheticDataset({ seed: 2026, size: 1000 });
  expect(syntheticCorpusHash(first)).toBe(syntheticCorpusHash(second));
  expect(second).toEqual(first);
  const other = generateSyntheticDataset({ seed: 2027, size: 1000 });
  expect(syntheticCorpusHash(other)).not.toBe(syntheticCorpusHash(first));
});

test("1.000 and 10.000 note corpora meet documented scale metadata", () => {
  for (const size of [1000, 10_000]) {
    const corpus = generateSyntheticDataset({ seed: 42, size });
    expect(corpus.notes).toHaveLength(size);
    expect(new Set(corpus.notes.map((note) => note.id)).size).toBe(size);
    expect(corpus.metadata).toEqual(
      computeSyntheticMetadata(corpus.notes, corpus.edges),
    );
    expect(corpus.metadata.noteCount).toBe(size);
    expect(corpus.metadata.edgeCount).toBeGreaterThanOrEqual(
      Math.floor(size * 1.25),
    );
    expect(corpus.metadata.averageOutDegree).toBeGreaterThanOrEqual(1.25);
    expect(corpus.metadata.pinCount).toBeGreaterThan(0);
    expect(corpus.metadata.pinRatio).toBeGreaterThan(0);
    expect(corpus.metadata.pinRatio).toBeLessThanOrEqual(1);
    expect(corpus.metadata.noteLength.min).toBeGreaterThan(0);
    expect(corpus.metadata.sectionLength.min).toBeGreaterThan(0);
    expect(corpus.metadata.languages.tr).toBeGreaterThan(0);
    expect(corpus.metadata.languages.en).toBeGreaterThan(0);
    expect(
      corpus.edges.filter((edge) => edge.predicate === "SUPERSEDES").length,
    ).toBeGreaterThan(0);
    const expectedDensity = corpus.metadata.edgeCount / (size * (size - 1));
    expect(corpus.metadata.edgeDensity).toBeCloseTo(expectedDensity, 9);
  }
});

test("needles point at strong matches in the tail of the id order", () => {
  for (const size of [1000, 10_000]) {
    const corpus = generateSyntheticDataset({ seed: 42, size });
    expect(corpus.needles).toHaveLength(5);
    for (const needle of corpus.needles) {
      expect(corpus.notes[needle.tailPosition]!.id).toBe(needle.noteId);
      // A scan of only the first records cannot reach the last 2% window.
      expect(needle.tailPosition).toBeGreaterThanOrEqual(
        Math.floor(size * 0.98),
      );
    }
    // Needle note ids are real notes, and no two needles share a target.
    const targets = new Set(corpus.needles.map((needle) => needle.noteId));
    expect(targets.size).toBe(corpus.needles.length);
    for (const needle of corpus.needles)
      expect(corpus.notes.some((note) => note.id === needle.noteId)).toBe(true);
  }
});

test("explicit options change the corpus deterministically", () => {
  const onlyTr = generateSyntheticDataset({
    seed: 5,
    size: 200,
    languages: ["tr"],
  });
  expect(onlyTr.metadata.languages).toEqual({ tr: 200, en: 0 });
  const dense = generateSyntheticDataset({
    seed: 5,
    size: 200,
    edgeDensity: 2.5,
  });
  expect(dense.metadata.edgeCount).toBeGreaterThanOrEqual(500);
  expect(() => generateSyntheticDataset({ seed: 5, size: 0 })).toThrow();
  expect(() =>
    generateSyntheticDataset({ seed: 5, size: 10, languages: [] }),
  ).toThrow();
});
