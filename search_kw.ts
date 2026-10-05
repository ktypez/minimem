// Keyword extraction for FTS5 trigram search.
//
// Two things this must get right that a naive word-split does not:
//
// 1. Identifiers survive. Intl.Segmenter("th", {granularity:"word"}) splits on
//    the hyphen and the underscore, so "13-theme" becomes ["13", "theme"] and
//    "0005_client_branch.sql" becomes ["0005", "client", "branch", "sql"].
//    Trigram MATCH on the fragments is far weaker than matching the whole
//    token, and the whole token is what the user actually pasted in.
//    So: harvest identifier-shaped runs first, then add the segmenter's words.
//
// 2. Stopwords do not flood the query. search() ORs every term together, so
//    "the"/"of"/"what" add noise rows and dilute BM25 ranking without ever
//    discriminating between candidates.
//
// Trigram tokenizer means every term must be >= 3 characters to match at all.

const STOP = new Set(
  `the a an and or but if then else of to in on at by for with from as it its
   this that these those there here what when where which who whom whose why how
   does do did done is are was were be been being am not no nor so than too very
   can could should would will shall may might must about into over under again
   ที่ ซึ่ง และ หรือ แต่ ก็ ของ ใน บน กับ เป็น คือ ได้ ให้ มา ไป จะ มี ไม่ ใช่
   อยู่ ครับ ค่ะ อย่าง จาก โดย เมื่อ เพื่อ แล้ว ยัง ต่อ ทั้ง หมด อีก ตัวไหน อะไร
   ด้วย ตัว ทำ ทำงาน เรื่อง แบบ เช่น เพื่อที่ จึง ยังไง อย่างไร`
    .split(/\s+/)
    .filter(Boolean),
);

const seg = new Intl.Segmenter("th", { granularity: "word" });

/** Identifier-shaped run: letter/digit, then anything that is not whitespace or Thai. */
const IDENT = /[0-9A-Za-z][0-9A-Za-z_./@:+-]*/g;

const clean = (w: string) => w.replace(/["']/g, "").replace(/[.,;:]+$/, "");

export function keywords(input: string, max = 24): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const w = clean(raw);
    if (!w) return;
    const key = w.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(w);
  };

  // Pass 1: identifiers, longest first, so "0005_client_branch.sql" is preferred
  // over its fragments. Cap generously but never mid-identifier.
  //
  // Only harvest tokens that actually LOOK like identifiers: they contain a
  // joining character (_ . / @ : + -) or mix letters with digits. Plain words
  // fall through to pass 2, where the stopword list can filter them.
  const idents = (input.match(IDENT) ?? [])
    .filter((t) => /[_./@:+-]/.test(t) || /\d/.test(t))
    .sort((a, b) => b.length - a.length);
  const stopIdents = new Set(["http", "https", "www"]);
  for (const id of idents) {
    if (stopIdents.has(id.toLowerCase())) continue;
    add(id);
    if (out.length >= max) return out;
  }

  // Pass 2: segmented words (this is what makes Thai work at all), skipping
  // stopwords and sub-trigram noise.
  for (const s of seg.segment(input)) {
    if (!s.isWordLike) continue;
    const w = clean(s.segment);
    if ([...w].length < 3) continue; // trigram cannot match these
    if (STOP.has(w.toLowerCase())) continue;
    add(w);
    if (out.length >= max) break;
  }

  return out;
}

/** Build the FTS5 MATCH expression. Terms are quoted so FTS5 treats
 *  hyphens/dots in identifiers as literal text, not query operators. */
export function matchExpr(terms: string[]): string {
  return terms.map((w) => `"${w.replace(/"/g, '""')}"`).join(" OR ");
}
