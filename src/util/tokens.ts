/**
 * Token estimation without a tokenizer.
 *
 * `kontext pack` budgets context in tokens, so it needs a number before it has
 * an LLM in the loop — and shipping a 2MB BPE vocab would defeat the
 * zero-dependency goal. This is a structural estimator, not `length / 4`.
 *
 * ── The heuristic ───────────────────────────────────────────────────────────
 * Text is split into *prose* and *fenced code* runs, because code tokenizes
 * roughly 30–40% denser than prose: identifiers break at camelCase and `_`
 * boundaries, punctuation is everywhere, and indentation itself costs tokens.
 *
 * Within a run we count structure rather than characters:
 *   • word-ish runs  ceil(len / 6) for prose, ceil(len / 4) for code, min 1.
 *                    Short common words are one token; long words split at
 *                    morpheme-ish boundaries roughly every 4–6 chars.
 *   • punctuation    runs of symbols cost ceil(run / 2) — BPE merges common
 *                    pairs like `=>`, `);`, `**`, `://`.
 *   • CJK            ~1.2 tokens per character (no word boundaries to exploit).
 *   • newlines       0.5 each — `\n` is often merged into a neighbouring token.
 *   • indentation    (code only) ceil(spaces / 4), which `length / 4` gets
 *                    right by accident and word counting misses entirely.
 *
 * ── Accuracy ────────────────────────────────────────────────────────────────
 * Against cl100k/Claude-style BPE on markdown docs this lands within roughly
 * ±15%, biased ~5–10% HIGH. High is the safe direction: an overestimate packs
 * slightly less context, an underestimate blows the model's context window.
 * It degrades on: long-word-heavy prose (over-counts, since "documentation" is
 * really one token), base64/minified blobs (under-counts badly), and non-Latin
 * scripts other than CJK (rough). It is good enough for budgeting and packing
 * decisions; it is not good enough for billing.
 */

/** Fence openers/closers: ``` or ~~~ , optionally indented. */
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;

/** CJK ideographs, kana and hangul — dense scripts with no word breaks. */
const CJK_RE = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/;

/** Latin letters, digits and Latin-1/Extended-A accents count as word chars. */
const WORD_RE = /[A-Za-z0-9À-ɏ]/;

interface Segment {
  text: string;
  code: boolean;
}

/**
 * Estimate the number of LLM tokens `text` would consume.
 * Returns 0 for empty/whitespace-only input, never NaN, never throws.
 */
export function estimateTokens(text: string): number {
  if (typeof text !== 'string' || text.trim().length === 0) return 0;

  let total = 0;
  for (const segment of splitCodeAndProse(text)) {
    total += segment.code ? countCode(segment.text) : countProse(segment.text);
  }
  return Math.max(1, Math.round(total));
}

/**
 * Trim `text` down to `maxTokens`, cutting on structure rather than mid-thought.
 *
 * Preference order: whole blocks (paragraphs / headings / intact code fences) →
 * sentence boundary → hard character cut. A truncated doc that ends mid-sentence
 * reads as corrupted to a model; one that ends at a heading boundary reads as
 * an excerpt. No ellipsis marker is appended — `truncated` is the signal, and
 * the caller owns presentation.
 */
export function truncateToTokens(
  text: string,
  maxTokens: number,
): { text: string; truncated: boolean } {
  if (typeof text !== 'string' || text.length === 0) {
    return { text: '', truncated: false };
  }
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
    return { text: '', truncated: text.trim().length > 0 };
  }
  if (estimateTokens(text) <= maxTokens) {
    return { text, truncated: false };
  }

  // 1. Whole-block truncation.
  const blocks = splitBlocks(text);
  const kept: string[] = [];
  let used = 0;
  for (const block of blocks) {
    const cost = estimateTokens(block);
    if (used + cost > maxTokens) break;
    kept.push(block);
    used += cost;
  }

  if (kept.length > 0) {
    return { text: closeDanglingFence(kept.join('\n\n').trimEnd()), truncated: true };
  }

  // 2. The very first block alone overflows (one giant paragraph or code
  //    block). Fall back to sentence boundaries inside it.
  const first = blocks[0] ?? text;
  const sentences = first.split(/(?<=[.!?])\s+/);
  const keptSentences: string[] = [];
  used = 0;
  for (const sentence of sentences) {
    const cost = estimateTokens(sentence);
    if (used + cost > maxTokens) break;
    keptSentences.push(sentence);
    used += cost;
  }
  if (keptSentences.length > 0) {
    return {
      text: closeDanglingFence(keptSentences.join(' ').trimEnd()),
      truncated: true,
    };
  }

  // 3. Nothing structural fits. Cut by characters using the observed density of
  //    this specific text rather than a generic 4-chars-per-token guess.
  const density = text.length / Math.max(1, estimateTokens(text));
  const cut = Math.max(1, Math.floor(maxTokens * density));
  return { text: closeDanglingFence(text.slice(0, cut).trimEnd()), truncated: true };
}

/* ------------------------------------------------------------------ *
 * Segmentation
 * ------------------------------------------------------------------ */

/** Split into alternating prose / fenced-code runs. Unclosed fences run to EOF. */
function splitCodeAndProse(text: string): Segment[] {
  const lines = text.split('\n');
  const segments: Segment[] = [];
  let buffer: string[] = [];
  let inCode = false;
  let fenceMarker = '';

  const flush = (code: boolean): void => {
    if (buffer.length === 0) return;
    segments.push({ text: buffer.join('\n'), code });
    buffer = [];
  };

  for (const line of lines) {
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const marker = fence[1]!;
      if (!inCode) {
        flush(false);
        inCode = true;
        fenceMarker = marker[0]!;
        buffer.push(line);
        continue;
      }
      // Only a fence of the same character closes the block.
      if (marker[0] === fenceMarker) {
        buffer.push(line);
        flush(true);
        inCode = false;
        continue;
      }
    }
    buffer.push(line);
  }
  flush(inCode);
  return segments;
}

/**
 * Split into truncation blocks: blank-line-separated paragraphs, with headings
 * starting a new block and fenced code kept whole (a half code block is worse
 * than no code block).
 */
function splitBlocks(text: string): string[] {
  const lines = text.split('\n');
  const blocks: string[] = [];
  let current: string[] = [];
  let inCode = false;
  let fenceMarker = '';

  const flush = (): void => {
    if (current.length === 0) return;
    const joined = current.join('\n').trim();
    if (joined.length > 0) blocks.push(joined);
    current = [];
  };

  for (const line of lines) {
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const marker = fence[1]!;
      if (!inCode) {
        flush();
        inCode = true;
        fenceMarker = marker[0]!;
        current.push(line);
        continue;
      }
      if (marker[0] === fenceMarker) {
        current.push(line);
        flush();
        inCode = false;
        continue;
      }
    }

    if (inCode) {
      current.push(line);
      continue;
    }

    if (line.trim().length === 0) {
      flush();
      continue;
    }
    // A heading always starts a block, so cuts land on section boundaries.
    if (/^#{1,6}\s/.test(line)) {
      flush();
      current.push(line);
      continue;
    }
    current.push(line);
  }
  flush();
  return blocks.length > 0 ? blocks : [text];
}

/** A truncated excerpt must never leave an unbalanced ``` behind. */
function closeDanglingFence(text: string): string {
  let open = false;
  let marker = '';
  for (const line of text.split('\n')) {
    const fence = FENCE_RE.exec(line);
    if (!fence) continue;
    const ch = fence[1]![0]!;
    if (!open) {
      open = true;
      marker = ch;
    } else if (ch === marker) {
      open = false;
    }
  }
  return open ? `${text}\n${marker.repeat(3)}` : text;
}

/* ------------------------------------------------------------------ *
 * Counting
 * ------------------------------------------------------------------ */

function countProse(text: string): number {
  return countRuns(text, 6, 0) + newlineCost(text);
}

function countCode(text: string): number {
  return countRuns(text, 4, 0) + newlineCost(text) + indentCost(text);
}

/**
 * Shared counter. `wordDivisor` controls how aggressively long word-ish runs
 * are assumed to split; `extra` is a hook for future per-mode tweaks.
 */
function countRuns(text: string, wordDivisor: number, extra: number): number {
  let total = extra;
  let wordLength = 0;
  let punctLength = 0;

  const flushWord = (): void => {
    if (wordLength === 0) return;
    total += Math.max(1, Math.ceil(wordLength / wordDivisor));
    wordLength = 0;
  };
  const flushPunct = (): void => {
    if (punctLength === 0) return;
    // BPE merges common symbol pairs (`=>`, `);`, `://`), so symbols are not
    // one token each.
    total += Math.max(1, Math.ceil(punctLength / 2));
    punctLength = 0;
  };

  for (const ch of text) {
    if (CJK_RE.test(ch)) {
      flushWord();
      flushPunct();
      total += 1.2;
      continue;
    }
    if (WORD_RE.test(ch)) {
      flushPunct();
      wordLength++;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      // Whitespace ends runs but costs nothing on its own: BPE attaches the
      // leading space to the following word.
      flushWord();
      flushPunct();
      continue;
    }
    flushWord();
    punctLength++;
  }
  flushWord();
  flushPunct();
  return total;
}

/** `\n` is usually merged into a neighbouring token; blank lines are not. */
function newlineCost(text: string): number {
  let newlines = 0;
  for (const ch of text) if (ch === '\n') newlines++;
  return newlines * 0.5;
}

/** Leading whitespace in code is real tokens — roughly one per 4 columns. */
function indentCost(text: string): number {
  let total = 0;
  for (const line of text.split('\n')) {
    const indent = /^[ \t]+/.exec(line);
    if (!indent) continue;
    const width = indent[0].replace(/\t/g, '    ').length;
    total += Math.ceil(width / 4);
  }
  return total;
}
