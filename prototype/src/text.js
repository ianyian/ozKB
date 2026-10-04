// Text utilities: tokenizing, hashing, MinHash for code clones, TF-IDF cosine for tickets.
import crypto from "node:crypto";

export const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

const STOP = new Set("a an and are as at be by for from has in is it its of on or that the to was were will with this each every when must can not no all any new per after before".split(" "));

// Words for similarity: split identifiers (snake_case, camelCase), lower-case, drop stop words.
export function words(text) {
  return String(text || "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w));
}

// Code tokens with comments and whitespace removed; identifiers and literals kept.
export function codeTokens(src, lang) {
  let s = src;
  if (lang === "python") s = s.replace(/#.*$/gm, "").replace(/"""[\s\S]*?"""/g, "");
  else s = s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  return s.match(/[A-Za-z_][A-Za-z0-9_]*|\d+|"[^"]*"|'[^']*'|[^\sA-Za-z0-9_]/g) || [];
}

const SEEDS = Array.from({ length: 64 }, (_, i) => (i + 1) * 0x9e3779b1);
function h32(str, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
export function minhash(tokens, k = 4) {
  const shingles = new Set();
  for (let i = 0; i + k <= tokens.length; i++) shingles.add(tokens.slice(i, i + k).join(" "));
  if (!shingles.size) shingles.add(tokens.join(" "));
  return SEEDS.map((seed) => {
    let min = 0xffffffff;
    for (const s of shingles) { const v = h32(s, seed); if (v < min) min = v; }
    return min | 0; // fits Postgres int4
  });
}
export function minhashSim(a, b) {
  let same = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) same++;
  return same / a.length;
}

// TF-IDF cosine over a small corpus.
export function tfidf(docs) {
  const df = new Map();
  const tfs = docs.map((d) => {
    const tf = new Map();
    for (const w of words(d)) tf.set(w, (tf.get(w) || 0) + 1);
    for (const w of tf.keys()) df.set(w, (df.get(w) || 0) + 1);
    return tf;
  });
  const n = docs.length;
  const vecs = tfs.map((tf) => {
    const v = new Map(); let norm = 0;
    for (const [w, c] of tf) { const x = (1 + Math.log(c)) * Math.log(1 + n / df.get(w)); v.set(w, x); norm += x * x; }
    norm = Math.sqrt(norm) || 1;
    for (const [w, x] of v) v.set(w, x / norm);
    return v;
  });
  return vecs;
}
export function cosine(a, b) {
  let s = 0;
  const [x, y] = a.size < b.size ? [a, b] : [b, a];
  for (const [w, v] of x) { const u = y.get(w); if (u) s += u * v; }
  return s;
}

// Words that carry no meaning in questions and search boxes ("which tasks related to ...").
export const FILLER = new Set(("which what where when who why how many much does do did is are was were the a an of for to in at on and or " +
  "have has had there any our we us it its this that these those from with by about can could should would may might me my i you your please " +
  "tell explain show list all know find give get see help need want looking look regarding related relating relevant around " +
  "site sites plant plants else built build developed develop development done made implemented implement implementation " +
  "function functions feature features functionality code repo exist exists existing use using used task tasks ticket tickets " +
  "request requests change changes cr crs mypm customer customers project projects work works anything something thing things").split(" "));

// Meaningful lower-case words of a question or search text.
export function contentTerms(text) {
  return String(text || "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !FILLER.has(w) && !/^\d+$/.test(w));
}
