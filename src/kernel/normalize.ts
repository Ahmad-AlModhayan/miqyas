// SPDX-License-Identifier: AGPL-3.0-only
// normalize(), the CEL extension that makes text comparable: case, Unicode forms, Arabic diacritics and letter
// variants, and spacing (docs/FOUNDATION.md §4, docs/cel-subset.md). Pure string functions, the same wherever claims
// are evaluated; the shared vectors are test/vectors/normalize.json.

/** Format characters that carry no letter: zero-width and direction marks, the byte order mark, the soft hyphen. */
const INVISIBLE = /[\u00AD\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/gu;

/** Arabic tatweel, the vowel and other marks (U+064B to U+065F), the superscript alef, and the Quranic annotation marks. */
const ARABIC_MARKS = /[\u0640\u064B-\u065F\u0670\u06D6-\u06DC\u06DF-\u06E4\u06E7\u06E8\u06EA-\u06ED]/gu;

/** The letter variants folded to one letter each. Hamza on waw and on yeh, and the digits, are left as they are. */
const LETTER_VARIANTS: Readonly<Record<string, string>> = {
  'آ': 'ا', // alef with madda above -> alef
  'أ': 'ا', // alef with hamza above -> alef
  'إ': 'ا', // alef with hamza below -> alef
  'ٱ': 'ا', // alef wasla -> alef
  'ى': 'ي', // alef maqsura -> yeh
  'ی': 'ي', // Persian yeh -> yeh
  'ة': 'ه', // teh marbuta -> heh
  'ک': 'ك', // Persian kaf -> kaf
};
const VARIANT = /[\u0622\u0623\u0625\u0671\u0649\u06CC\u0629\u06A9]/gu;

/** Unicode White_Space, which `\s` matches; the byte order mark that `\s` also matches is gone by then. */
const SPACE_RUN = /\s+/gu;

/**
 * 1. Unicode form NFKC.
 * 2. Remove invisible format characters.
 * 3. Remove Arabic tatweel and diacritics.
 * 4. Fold Arabic letter variants.
 * 5. Lower case, by the Unicode default mapping and not by locale.
 * 6. NFKC again, so that the result is stable.
 * 7. Every run of white space becomes one space, and the ends are trimmed.
 */
export function normalize(text: string): string {
  return text
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .replace(ARABIC_MARKS, '')
    .replace(VARIANT, (letter) => LETTER_VARIANTS[letter] ?? letter)
    .toLowerCase()
    .normalize('NFKC')
    .replace(SPACE_RUN, ' ')
    .trim();
}
